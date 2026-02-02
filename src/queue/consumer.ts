import { setStatus } from "../state/status";
import { RedisQueueClient } from "./redis";
import { IntentMessage, ValidatedIntent } from "./types";
import { validateIntent } from "./validation";
import { config } from "../config";
import { flowRegistry, createFlowContext } from "../flows";
import { emitFlowMetrics, categorizeError } from "../flows/metrics";
import { refundSolanaTokensToUser, refundNearTokensToUser, refundEvmTokensToUser } from "../utils/refund";
import { EVM_SWAP_CHAINS, EvmChainName } from "../utils/evmChains";

/**
 * Starts the queue consumer with parallel processing support.
 * Uses a worker pool pattern to process multiple intents concurrently.
 */
export async function startQueueConsumer() {
  const queue = new RedisQueueClient();
  const concurrency = config.queueConcurrency;
  let activeWorkers = 0;

  console.log(`Starting queue consumer with concurrency: ${concurrency}`);

  // Fire-and-forget loop; log errors so the server keeps running.
  (async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Wait if we've hit max concurrency
      if (activeWorkers >= concurrency) {
        await delay(100);
        continue;
      }

      const next = await queue.fetchNextIntent();
      if (!next.intent || !next.raw) {
        if (next.raw) {
          console.warn("[consumer] Received malformed intent message, acknowledging and skipping:", next.raw.substring(0, 200));
          await queue.ackIntent(next.raw);
        }
        continue;
      }

      // Spawn worker for this intent (don't await - run in parallel)
      activeWorkers++;
      processIntent(next.intent, next.raw, queue)
        .finally(() => {
          activeWorkers--;
        });
    }
  })().catch((err) => {
    console.error("Queue consumer crashed", err);
  });
}

/**
 * Processes a single intent with validation, retry logic, and cleanup.
 */
async function processIntent(
  intentMessage: IntentMessage,
  raw: string,
  queue: RedisQueueClient,
) {
  try {
    const intent = validateIntent(intentMessage);
    await processIntentWithRetry(intent, raw, queue);
  } catch (err) {
    console.error("Intent processing failed", err);
    await setStatus(intentMessage.intentId, {
      state: "failed",
      error: (err as Error).message || "unknown error",
    });
  } finally {
    await queue.ackIntent(raw);
  }
}

async function processIntentWithRetry(
  intent: ValidatedIntent,
  raw: string,
  queue: RedisQueueClient,
) {
  let attempt = 0;
  while (attempt < config.maxIntentAttempts) {
    attempt += 1;
    try {
      await setStatus(intent.intentId, {
        state: "processing",
        detail: `attempt ${attempt}/${config.maxIntentAttempts}`,
      });

      const result = await executeIntentFlow(intent);

      // If the intent is awaiting intents delivery, don't overwrite the status
      // The poller will handle the next step when intents completes
      if (result.txId.startsWith("awaiting-intents-")) {
        return;
      }

      await setStatus(intent.intentId, {
        state: "succeeded",
        txId: result.txId,
      });
      return;
    } catch (err) {
      const isLast = attempt >= config.maxIntentAttempts;
      console.error(
        `Intent ${intent.intentId} failed on attempt ${attempt}/${config.maxIntentAttempts}`,
        err,
      );
      if (isLast) {
        // Attempt to refund intermediate tokens to the user before marking as failed
        const refundResult = await attemptRefund(intent);

        await setStatus(intent.intentId, {
          state: "failed",
          error: (err as Error).message || "unknown error",
          ...(refundResult && {
            refundTxId: refundResult.txId,
            detail: `Refund sent: ${refundResult.amount} to ${intent.userDestination}`,
          }),
        });
        await queue.moveToDeadLetter(raw);
        return;
      }
      await setStatus(intent.intentId, {
        state: "processing",
        detail: `retrying (attempt ${attempt + 1}/${config.maxIntentAttempts})`,
      });
      await delay(config.intentRetryBackoffMs * attempt);
    }
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempts to refund intermediate tokens to the user after all retry attempts
 * have been exhausted. Only applicable for chained cross-chain swaps where the
 * bridge leg completed (intentsCompleted) but the destination swap failed.
 */
async function attemptRefund(
  intent: ValidatedIntent,
): Promise<{ txId: string; amount: string } | null> {
  if (!intent.intermediateAsset || !intent.userDestination) return null;

  // Only refund if the bridge leg already completed — otherwise Defuse handles the refund
  if (!(intent.metadata as any)?.intentsCompleted) return null;

  try {
    if (intent.destinationChain === "solana") {
      return await refundSolanaTokensToUser(
        intent.intermediateAsset,
        intent.userDestination,
        console,
        config.dryRunSwaps,
      );
    }
    if (intent.destinationChain === "near") {
      return await refundNearTokensToUser(
        intent.intermediateAsset,
        intent.userDestination,
        console,
        config.dryRunSwaps,
      );
    }
    if (EVM_SWAP_CHAINS.includes(intent.destinationChain as EvmChainName)) {
      return await refundEvmTokensToUser(
        intent.destinationChain as EvmChainName,
        intent.intermediateAsset,
        intent.userDestination,
        console,
        config.dryRunSwaps,
      );
    }
  } catch (refundErr) {
    console.error(
      `[consumer] Refund attempt failed for ${intent.intentId}:`,
      refundErr,
    );
  }
  return null;
}

/**
 * Check if this is a cross-chain swap that needs to wait for intents delivery
 */
function needsIntentsWait(intent: ValidatedIntent): boolean {
  // If intents already completed (re-queued by poller), skip waiting
  if ((intent.metadata as any)?.intentsCompleted) {
    return false;
  }

  // Sell flow: user TX already confirmed on-chain, no bridge-in needed
  if ((intent.metadata as any)?.userTxConfirmed) {
    return false;
  }

  // If there's a deposit address and intermediate amount, this is a cross-chain swap
  // that needs to wait for intents to deliver funds
  if (intent.intentsDepositAddress && intent.intermediateAmount) {
    return true;
  }

  // If source chain is different from destination chain and we have intermediate asset
  if (intent.sourceChain !== intent.destinationChain && intent.intermediateAsset) {
    return true;
  }

  return false;
}

/**
 * Routes the intent to the appropriate execution flow based on metadata.
 * Uses the flow registry to find and execute the matching flow.
 */
async function executeIntentFlow(
  intent: ValidatedIntent,
): Promise<{ txId: string }> {
  // Check if we need to wait for intents cross-chain swap to complete
  if (needsIntentsWait(intent)) {
    console.log(`[consumer] Intent ${intent.intentId} needs to wait for intents delivery`);

    // Set status to awaiting_intents with all the info needed to poll and re-process
    await setStatus(intent.intentId, {
      state: "awaiting_intents",
      detail: "Waiting for cross-chain swap to complete",
      depositAddress: intent.intentsDepositAddress,
      depositMemo: intent.depositMemo,
      intentData: intent,
    });

    // Return a placeholder - the actual swap will happen after poller detects completion
    return { txId: `awaiting-intents-${intent.intentId}` };
  }

  // Find matching flow from registry
  const flow = flowRegistry.findMatch(intent);

  if (!flow) {
    const action = intent.metadata?.action;
    throw new Error(
      `No flow registered for action: ${action ?? "undefined"}. ` +
      `Registered flows: ${flowRegistry.getAll().map((f) => f.action).join(", ")}`
    );
  }

  console.log(`[consumer] Dispatching intent ${intent.intentId} to flow: ${flow.action}`);

  // Create flow context with status update capability and metrics
  const ctx = createFlowContext({
    intentId: intent.intentId,
    config,
    flowAction: flow.action,
    flowName: flow.name,
    setStatus: async (status, detail) => {
      await setStatus(intent.intentId, {
        state: status as any,
        ...detail,
      });
    },
  });

  // Set chain info for metrics
  ctx.metrics.setChains(intent.sourceChain, intent.destinationChain);
  ctx.metrics.setAmounts(intent.sourceAmount);

  try {
    // Validate authorization if the flow requires it
    if (flow.validateAuthorization) {
      ctx.metrics.startStep("authorization");
      await flow.validateAuthorization(intent as any, ctx);
      ctx.metrics.endStep(true);
    }

    // Execute the flow
    ctx.metrics.startStep("execute");
    const result = await flow.execute(intent as any, ctx);
    ctx.metrics.endStep(true);

    // Capture result data for metrics
    if (result.txId) ctx.metrics.setTxId(result.txId);
    if (result.swappedAmount) ctx.metrics.setAmounts(intent.sourceAmount, result.swappedAmount);

    // Emit success metrics
    emitFlowMetrics(ctx.metrics.success(), ctx.logger);

    return result;
  } catch (err) {
    // Emit failure metrics
    const errorType = categorizeError(err);
    emitFlowMetrics(ctx.metrics.failure(errorType, (err as Error).message), ctx.logger);
    throw err;
  }
}
