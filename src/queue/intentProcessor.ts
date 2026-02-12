import type { FlowCatalog } from "../flows/catalog";
import type { Logger } from "../types/logger";
import type { AppConfig, FlowContext, FlowResult } from "../flows/types";
import { emitFlowMetrics, categorizeError } from "../flows/metrics";
import type { IntentStatus } from "../state/status";
import { EVM_SWAP_CHAINS, EvmChainName } from "../utils/evmChains";
import {
  refundEvmTokensToUser,
  refundNearTokensToUser,
  refundSolanaTokensToUser,
} from "../utils/refund";
import { createLogger } from "../utils/logger";
import type { IntentMessage, ValidatedIntent } from "./types";
import type { IntentValidator } from "./validation";

export interface QueueDeadLetterPort {
  moveToDeadLetter(raw: string): Promise<void>;
}

export interface IntentProcessorDeps {
  appConfig: AppConfig;
  flowCatalog: FlowCatalog;
  validateIntent: IntentValidator;
  setStatus: (intentId: string, status: IntentStatus) => Promise<void>;
  createFlowContext: (options: {
    intentId: string;
    config?: AppConfig;
    flowAction?: string;
    flowName?: string;
    setStatus?: (status: IntentStatus["state"], detail?: Record<string, unknown>) => Promise<void>;
  }) => FlowContext;
  queue: QueueDeadLetterPort;
  delay: (ms: number) => Promise<void>;
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

export interface IntentProcessor {
  processIntent(intentMessage: IntentMessage, raw: string): Promise<void>;
}

const refundLog = createLogger("refund");
const processorLog = createLogger("intentProcessor");

export function createIntentProcessor(deps: IntentProcessorDeps): IntentProcessor {
  const log = deps.logger ?? createLogger("intentProcessor");

  async function processIntent(intentMessage: IntentMessage, raw: string): Promise<void> {
    try {
      const intent = deps.validateIntent(intentMessage);
      await processIntentWithRetry(intent, raw);
    } catch (err) {
      log.error("Intent processing failed", { err: String(err) });
      await deps.setStatus(intentMessage.intentId, {
        state: "failed",
        error: (err as Error).message || "unknown error",
      });
    }
  }

  async function processIntentWithRetry(intent: ValidatedIntent, raw: string) {
    let attempt = 0;
    let executedResult: FlowResult | null = null;

    while (attempt < deps.appConfig.maxIntentAttempts) {
      attempt += 1;
      try {
        await deps.setStatus(intent.intentId, {
          state: "processing",
          detail: `attempt ${attempt}/${deps.appConfig.maxIntentAttempts}`,
        });

        if (!executedResult) {
          executedResult = await executeIntentFlow(intent);
        }

        // The poller will continue this flow after intents delivery.
        if (executedResult.txId.startsWith("awaiting-intents-")) {
          return;
        }

        await deps.setStatus(intent.intentId, {
          state: "succeeded",
          txId: executedResult.txId,
        });
        return;
      } catch (err) {
        const isLast = attempt >= deps.appConfig.maxIntentAttempts;
        log.error(
          `Intent ${intent.intentId} failed on attempt ${attempt}/${deps.appConfig.maxIntentAttempts}`,
          { err: String(err) },
        );

        if (executedResult) {
          if (isLast) {
            try {
              await deps.setStatus(intent.intentId, {
                state: "failed",
                txId: executedResult.txId,
                error: "Flow execution finished but completion status could not be persisted",
                detail: "Check logs and reconcile status manually",
              });
            } catch (statusErr) {
              log.error("Failed to persist terminal failure after completed execution", {
                intentId: intent.intentId,
                txId: executedResult.txId,
                err: String(statusErr),
              });
            }
            await deps.queue.moveToDeadLetter(raw);
            return;
          }
          await deps.delay(deps.appConfig.intentRetryBackoffMs * attempt);
          continue;
        }

        if (isLast) {
          const refundResult = await attemptRefund(intent, deps.appConfig.dryRunSwaps);
          await deps.setStatus(intent.intentId, {
            state: "failed",
            error: (err as Error).message || "unknown error",
            ...(refundResult && {
              refundTxId: refundResult.txId,
              detail: `Refund sent: ${refundResult.amount} to ${intent.userDestination}`,
            }),
          });
          await deps.queue.moveToDeadLetter(raw);
          return;
        }

        await deps.setStatus(intent.intentId, {
          state: "processing",
          detail: `retrying (attempt ${attempt + 1}/${deps.appConfig.maxIntentAttempts})`,
        });
        await deps.delay(deps.appConfig.intentRetryBackoffMs * attempt);
      }
    }
  }

  async function executeIntentFlow(intent: ValidatedIntent): Promise<FlowResult> {
    if (needsIntentsWait(intent)) {
      log.info(`Intent ${intent.intentId} needs to wait for intents delivery`);
      await deps.setStatus(intent.intentId, {
        state: "awaiting_intents",
        detail: "Waiting for cross-chain swap to complete",
        depositAddress: intent.intentsDepositAddress,
        depositMemo: intent.depositMemo,
        intentData: intent,
      });
      return { txId: `awaiting-intents-${intent.intentId}` };
    }

    const flow = deps.flowCatalog.findMatch(intent);
    if (!flow) {
      const action = intent.metadata?.action;
      throw new Error(
        `No flow registered for action: ${action ?? "undefined"}. ` +
          `Registered flows: ${deps.flowCatalog.getAll().map((f) => f.action).join(", ")}`,
      );
    }

    log.info(`Dispatching intent ${intent.intentId} to flow: ${flow.action}`);

    const ctx = deps.createFlowContext({
      intentId: intent.intentId,
      config: deps.appConfig,
      flowAction: flow.action,
      flowName: flow.name,
      setStatus: async (status, detail) => {
        await deps.setStatus(intent.intentId, { state: status, ...detail });
      },
    });

    ctx.metrics.setChains(intent.sourceChain, intent.destinationChain);
    ctx.metrics.setAmounts(intent.sourceAmount);

    try {
      if (flow.validateAuthorization) {
        ctx.metrics.startStep("authorization");
        // `as any` justified: heterogeneous registry pattern — flow.isMatch() already validated the type
        await flow.validateAuthorization(intent as any, ctx);
        ctx.metrics.endStep(true);
      }

      ctx.metrics.startStep("execute");
      // `as any` justified: heterogeneous registry pattern — flow.isMatch() already validated the type
      const result = await flow.execute(intent as any, ctx);
      ctx.metrics.endStep(true);

      if (result.txId) ctx.metrics.setTxId(result.txId);
      if (result.swappedAmount) ctx.metrics.setAmounts(intent.sourceAmount, result.swappedAmount);
      emitFlowMetrics(ctx.metrics.success(), ctx.logger);

      return result;
    } catch (err) {
      const errorType = categorizeError(err);
      emitFlowMetrics(ctx.metrics.failure(errorType, (err as Error).message), ctx.logger);
      throw err;
    }
  }

  return { processIntent };
}

export function needsIntentsWait(intent: ValidatedIntent): boolean {
  if (intent.metadata?.intentsCompleted) {
    return false;
  }

  // Sell flow: user TX already confirmed on-chain, no bridge-in needed
  if (intent.metadata?.userTxConfirmed) {
    return false;
  }

  if (intent.intentsDepositAddress && intent.intermediateAmount) {
    return true;
  }

  if (intent.sourceChain !== intent.destinationChain && intent.intermediateAsset) {
    return true;
  }

  return false;
}

async function attemptRefund(
  intent: ValidatedIntent,
  dryRunSwaps: boolean,
): Promise<{ txId: string; amount: string } | null> {
  if (!intent.intermediateAsset || !intent.userDestination) return null;
  if (!intent.metadata?.intentsCompleted) return null;

  try {
    if (intent.destinationChain === "solana") {
      return await refundSolanaTokensToUser(
        intent.intermediateAsset,
        intent.userDestination,
        refundLog,
        dryRunSwaps,
      );
    }
    if (intent.destinationChain === "near") {
      return await refundNearTokensToUser(
        intent.intermediateAsset,
        intent.userDestination,
        refundLog,
        dryRunSwaps,
      );
    }
    if (EVM_SWAP_CHAINS.includes(intent.destinationChain as EvmChainName)) {
      return await refundEvmTokensToUser(
        intent.destinationChain as EvmChainName,
        intent.intermediateAsset,
        intent.userDestination,
        refundLog,
        dryRunSwaps,
      );
    }
  } catch {
    processorLog.error(`Refund attempt failed for ${intent.intentId}`);
    return null;
  }

  return null;
}
