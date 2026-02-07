import {
  init_env,
  ftGetTokenMetadata,
  fetchAllPools,
  estimateSwap,
  instantSwap,
  Transaction as RefTransaction,
  Pool,
} from "@ref-finance/ref-sdk";
import { isTestnet } from "../config";
import { NearSwapMetadata, ValidatedIntent } from "../queue/types";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
  executeNearFunctionCall,
  NEAR_DEFAULT_PATH,
} from "../utils/near";
import { logNearAddressInfo } from "./context";
import { requireUserDestination } from "../utils/authorization";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger } from "./types";

// Initialize ref-sdk environment
init_env(isTestnet ? "testnet" : "mainnet");

// Default gas for ref-finance operations (300 TGas)
const DEFAULT_REF_GAS = BigInt("300000000000000");

// ─── Helper Functions ──────────────────────────────────────────────────────────

async function buildRefSwapTransactions(
  intent: ValidatedIntent & { metadata: NearSwapMetadata },
  accountId: string,
  logger: Logger,
): Promise<RefTransaction[]> {
  const meta = intent.metadata;

  const inputTokenId = meta.tokenIn;
  const outputTokenId = meta.tokenOut;
  const amountIn = intent.intermediateAmount || intent.sourceAmount;
  const slippageTolerance = (intent.slippageBps || 100) / 10000;

  logger.debug(`Building swap transactions`, {
    inputTokenId,
    outputTokenId,
    amountIn,
    slippageTolerance,
    accountId,
  });

  const [tokenIn, tokenOut] = await Promise.all([
    ftGetTokenMetadata(inputTokenId),
    ftGetTokenMetadata(outputTokenId),
  ]);

  logger.debug(`Token metadata loaded`, {
    tokenIn: { id: tokenIn.id, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
    tokenOut: { id: tokenOut.id, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
  });

  const { simplePools, stablePools, stablePoolsDetail } = await fetchAllPools();

  logger.debug(`Pools loaded`, {
    simplePools: simplePools?.length || 0,
    stablePools: stablePools?.length || 0,
  });

  const swapTodos = await estimateSwap({
    tokenIn,
    tokenOut,
    amountIn,
    simplePools: simplePools as Pool[],
    options: {
      enableSmartRouting: true,
      stablePools: stablePools as Pool[],
      stablePoolsDetail,
    },
  });

  if (!swapTodos || swapTodos.length === 0) {
    throw new Error(`No swap route found for ${inputTokenId} -> ${outputTokenId}`);
  }

  logger.debug(`Swap route found with ${swapTodos.length} steps`);

  const transactions = await instantSwap({
    tokenIn,
    tokenOut,
    amountIn,
    slippageTolerance,
    swapTodos,
    AccountId: accountId,
  });

  return transactions;
}

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

    if (config.dryRunSwaps) {
      return { txId: `dry-run-near-swap-${intent.intentId}` };
    }

    if (!intent.userDestination) {
      throw new Error(`[nearSwap] Missing userDestination for intent ${intent.intentId}`);
    }

    // Derive agent's NEAR account with userDestination in path for custody isolation
    const userAgent = await deriveNearAgentAccount(NEAR_DEFAULT_PATH, intent.userDestination);

    logNearAddressInfo(logger, intent.userDestination, userAgent);

    // Ensure the implicit account exists (fund it if needed)
    await ensureNearAccountFunded(userAgent.accountId);

    // Build and execute the swap transactions
    const transactions = await buildRefSwapTransactions(intent, userAgent.accountId, logger);

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

// Legacy exports for backwards compatibility
export const isNearSwapIntent = nearSwapFlow.isMatch;

import { config as globalConfig } from "../config";
import { createFlowContext } from "./context";

export async function executeNearSwapFlow(
  intent: ValidatedIntent,
): Promise<FlowResult> {
  if (!nearSwapFlow.isMatch(intent)) {
    throw new Error("Intent does not match NEAR swap flow");
  }
  const ctx = createFlowContext({ intentId: intent.intentId, config: globalConfig });
  if (nearSwapFlow.validateAuthorization) {
    await nearSwapFlow.validateAuthorization(intent, ctx);
  }
  return nearSwapFlow.execute(intent, ctx);
}
