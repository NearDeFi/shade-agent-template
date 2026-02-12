import { extractEvmTokenAddress } from "../constants";
import { EvmSwapMetadata, ValidatedIntent } from "../queue/types";
import {
  EVM_SWAP_CHAINS,
  EvmChainName,
  deriveEvmAgentAddress,
  signAndBroadcastEvmTx,
  EVM_CHAIN_CONFIGS,
} from "../utils/evmChains";
import { ensureErc20Allowance, transferEvmTokensToUser } from "../utils/evmLending";
import { fetchWithRetry } from "../utils/http";
import { requireUserDestination } from "../utils/authorization";
import { config } from "../config";
import { isNativeEvmToken as isNativeToken } from "../utils/common";
import { dryRunResult } from "./context";
import type { FlowDefinition, FlowContext, FlowResult, Logger } from "./types";

/**
 * Fetches a 0x swap quote for the given parameters.
 */
async function getZeroExQuote(
  chain: EvmChainName,
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  takerAddress: string,
  logger: Logger,
): Promise<{
  to: string;
  data: string;
  value: string;
  buyAmount: string;
  allowanceTarget: string;
  estimatedGas: string;
}> {
  const chainConfig = EVM_CHAIN_CONFIGS[chain];
  const url = new URL(`${chainConfig.zeroExBaseUrl}/swap/v1/quote`);
  url.searchParams.set("sellToken", sellToken);
  url.searchParams.set("buyToken", buyToken);
  url.searchParams.set("sellAmount", sellAmount);
  url.searchParams.set("takerAddress", takerAddress);

  logger.info(`[evmSwap] 0x quote request`, {
    chain,
    sellToken,
    buyToken,
    sellAmount,
    takerAddress,
    url: url.toString(),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.zeroExApiKey) {
    headers["0x-api-key"] = config.zeroExApiKey;
  }

  const res = await fetchWithRetry(
    url.toString(),
    { headers },
    config.zeroExMaxAttempts,
    config.zeroExRetryBackoffMs,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`0x quote failed (${chain}): ${res.status} ${res.statusText} - ${body}`);
  }

  const quote = await res.json();
  return {
    to: quote.to,
    data: quote.data,
    value: quote.value || "0",
    buyAmount: quote.buyAmount,
    allowanceTarget: quote.allowanceTarget,
    estimatedGas: quote.estimatedGas || "0",
  };
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

const evmSwapFlow: FlowDefinition<EvmSwapMetadata> = {
  action: "evm-swap",
  name: "EVM Swap",
  description: "Swap tokens on Ethereum, Base, Arbitrum, or BNB Chain using 0x DEX aggregator",

  supportedChains: {
    source: ["near", "ethereum", "base", "arbitrum", "bnb", "solana"],
    destination: ["ethereum", "base", "arbitrum", "bnb"],
  },

  requiredMetadataFields: [],
  optionalMetadataFields: [],

  isMatch: (intent): intent is ValidatedIntent & { metadata: EvmSwapMetadata } => {
    const action = intent.metadata?.action;
    return (
      EVM_SWAP_CHAINS.includes(intent.destinationChain as EvmChainName) &&
      (!action || action === "evm-swap")
    );
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "EVM swap");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config: appConfig, logger } = ctx;
    const chain = intent.destinationChain as EvmChainName;

    const dry = dryRunResult("evm-swap", intent.intentId, appConfig);
    if (dry) return dry;

    // 1. Derive agent EVM address
    const agentAddress = await deriveEvmAgentAddress(intent.userDestination);
    logger.info(`[evmSwap] Agent address derived`, { chain, agentAddress });

    // 2. Extract sell/buy token addresses
    const sellToken = extractEvmTokenAddress(intent.intermediateAsset || intent.sourceAsset);
    const buyToken = extractEvmTokenAddress(intent.finalAsset);

    const rawAmount = intent.intermediateAmount || intent.destinationAmount || intent.sourceAmount;

    // Reserve gas for the swap tx + approve tx + transfer-to-user tx.
    // On L2s (Base, Arbitrum) gas is cheap; on mainnet/BNB it's more expensive.
    // We deduct from sellAmount only when selling native ETH/BNB, since ERC-20
    // sells still need a separate native balance for gas.
    let sellAmount = rawAmount;
    if (isNativeToken(sellToken)) {
      const GAS_RESERVE_WEI = BigInt(
        chain === "ethereum" ? 8_000_000_000_000_000   // ~0.008 ETH
          : chain === "bnb" ? 3_000_000_000_000_000    // ~0.003 BNB
          : 800_000_000_000_000                         // ~0.0008 ETH (L2s)
      );
      const rawBigInt = BigInt(rawAmount);
      if (rawBigInt <= GAS_RESERVE_WEI) {
        throw new Error(
          `Insufficient native token amount (${rawAmount} wei) to cover gas reserve of ${GAS_RESERVE_WEI} wei on ${chain}`,
        );
      }
      sellAmount = (rawBigInt - GAS_RESERVE_WEI).toString();

      logger.info(`[evmSwap] Gas reserve deducted from native sell amount`, {
        chain,
        rawAmount,
        sellAmount,
        gasReserve: GAS_RESERVE_WEI.toString(),
      });
    }

    logger.info(`[evmSwap] Swap parameters`, {
      chain,
      sellToken,
      buyToken,
      rawAmount,
      sellAmount,
      agentAddress,
      userDestination: intent.userDestination,
    });

    // 3. Get 0x quote
    const quote = await getZeroExQuote(
      chain,
      sellToken,
      buyToken,
      sellAmount,
      agentAddress,
      logger,
    );

    logger.info(`[evmSwap] 0x quote received`, {
      chain,
      buyAmount: quote.buyAmount,
      allowanceTarget: quote.allowanceTarget,
      to: quote.to,
    });

    // 4. If selling ERC-20, ensure allowance
    const txIds: string[] = [];
    if (!isNativeToken(sellToken) && quote.allowanceTarget) {
      const approveTx = await ensureErc20Allowance(
        chain,
        sellToken,
        agentAddress,
        quote.allowanceTarget,
        BigInt(sellAmount),
        intent.userDestination,
        logger,
      );
      if (approveTx) {
        txIds.push(approveTx);
      }
    }

    // 5. Execute the swap
    const swapTxHash = await signAndBroadcastEvmTx(
      chain,
      {
        from: agentAddress,
        to: quote.to,
        data: quote.data,
        value: quote.value,
      },
      intent.userDestination,
    );
    txIds.push(swapTxHash);
    logger.info(`[evmSwap] Swap tx confirmed: ${swapTxHash}`, { chain });

    // 6. Transfer output tokens from agent to user
    const transferTxHash = await transferEvmTokensToUser(
      chain,
      buyToken,
      agentAddress,
      intent.userDestination,
      logger,
    );
    txIds.push(transferTxHash);
    logger.info(`[evmSwap] Transfer to user confirmed: ${transferTxHash}`, { chain });

    return {
      txId: swapTxHash,
      txIds,
      swappedAmount: quote.buyAmount,
    };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { evmSwapFlow };
