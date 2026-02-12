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
import type { Logger } from "../types/logger";

// Initialize ref-sdk environment (runs once on import)
init_env(isTestnet ? "testnet" : "mainnet");

// Default gas for ref-finance operations (300 TGas)
export const DEFAULT_REF_GAS = BigInt("300000000000000");

export type { RefTransaction };

export interface RefSwapParams {
  inputToken: string;
  outputToken: string;
  amount: string;
  slippageBps: number;
  accountId: string;
  logger: Logger;
}

/**
 * Build Ref Finance swap transactions for a given token pair.
 * Fetches token metadata, finds optimal route, and returns executable transactions.
 */
export async function buildRefSwapTransactions(
  params: RefSwapParams,
): Promise<RefTransaction[]> {
  const { inputToken, outputToken, amount, slippageBps, accountId, logger } = params;
  const slippageTolerance = (slippageBps || 100) / 10000;

  logger.debug(`Building Ref swap transactions`, {
    inputToken,
    outputToken,
    amount,
    slippageTolerance,
    accountId,
  });

  const [tokenIn, tokenOut] = await Promise.all([
    ftGetTokenMetadata(inputToken),
    ftGetTokenMetadata(outputToken),
  ]);

  logger.debug(`Token metadata loaded`, {
    tokenIn: { id: tokenIn.id, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
    tokenOut: { id: tokenOut.id, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
  });

  const { simplePools, stablePools, stablePoolsDetail } = await fetchAllPools();

  const swapTodos = await estimateSwap({
    tokenIn,
    tokenOut,
    amountIn: amount,
    simplePools: simplePools as Pool[],
    options: {
      enableSmartRouting: true,
      stablePools: stablePools as Pool[],
      stablePoolsDetail,
    },
  });

  if (!swapTodos || swapTodos.length === 0) {
    throw new Error(`No swap route found for ${inputToken} -> ${outputToken}`);
  }

  logger.debug(`Swap route found with ${swapTodos.length} steps`);

  const transactions = await instantSwap({
    tokenIn,
    tokenOut,
    amountIn: amount,
    slippageTolerance,
    swapTodos,
    AccountId: accountId,
  });

  return transactions;
}
