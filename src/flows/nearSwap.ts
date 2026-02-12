import { NearSwapMetadata, ValidatedIntent } from "../queue/types";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
  executeNearFunctionCall,
  NEAR_DEFAULT_PATH,
} from "../utils/near";
import { buildRefSwapTransactions, DEFAULT_REF_GAS } from "../utils/refFinance";
import { logNearAddressInfo, dryRunResult } from "./context";
import { requireUserDestination } from "../utils/authorization";
import type { FlowDefinition, FlowContext, FlowResult } from "./types";

// ─── Flow Definition ───────────────────────────────────────────────────────────

const nearSwapFlow: FlowDefinition<NearSwapMetadata> = {
  action: "near-swap",
  name: "NEAR Swap",
  description: "Swap tokens on NEAR using Ref Finance DEX",

  supportedChains: {
    source: ["near", "ethereum", "base", "arbitrum", "solana"],
    destination: ["near"],
  },

  requiredMetadataFields: ["action", "tokenIn", "tokenOut"],
  optionalMetadataFields: [],

  isMatch: (intent): intent is ValidatedIntent & { metadata: NearSwapMetadata } => {
    const meta = intent.metadata as NearSwapMetadata | undefined;
    return meta?.action === "near-swap";
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "NEAR swap");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;

    const dry = dryRunResult("near-swap", intent.intentId, config);
    if (dry) return dry;

    if (!intent.userDestination) {
      throw new Error(`[nearSwap] Missing userDestination for intent ${intent.intentId}`);
    }

    // Derive agent's NEAR account with userDestination in path for custody isolation
    const userAgent = await deriveNearAgentAccount(NEAR_DEFAULT_PATH, intent.userDestination);

    logNearAddressInfo(logger, intent.userDestination, userAgent);

    // Ensure the implicit account exists (fund it if needed)
    await ensureNearAccountFunded(userAgent.accountId);

    // Build and execute the swap transactions
    const meta = intent.metadata;
    const transactions = await buildRefSwapTransactions({
      inputToken: meta.tokenIn,
      outputToken: meta.tokenOut,
      amount: intent.intermediateAmount || intent.sourceAmount,
      slippageBps: intent.slippageBps,
      accountId: userAgent.accountId,
      logger,
    });

    logger.info(`Got ${transactions.length} transactions from Ref SDK`);

    // Execute each transaction sequentially
    const txIds: string[] = [];
    for (let i = 0; i < transactions.length; i++) {
      const refTx = transactions[i];
      logger.info(`Executing transaction ${i + 1}/${transactions.length} to ${refTx.receiverId}`);

      for (const functionCall of refTx.functionCalls) {
        const txId = await executeNearFunctionCall({
          from: userAgent,
          receiverId: refTx.receiverId,
          methodName: functionCall.methodName,
          args: (functionCall.args || {}) as Record<string, unknown>,
          gas: functionCall.gas ? BigInt(functionCall.gas) : DEFAULT_REF_GAS,
          deposit: functionCall.amount ? BigInt(functionCall.amount) : BigInt(0),
        });

        txIds.push(txId);
        logger.info(`Transaction confirmed: ${txId}`);
      }
    }

    logger.info(`Swap completed with ${txIds.length} transactions`);

    return {
      txId: txIds[txIds.length - 1],
      txIds,
    };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { nearSwapFlow };
