import { encodeFunctionData } from "viem";
import { extractEvmTokenAddress } from "../constants";
import { MorphoDepositMetadata, ValidatedIntent } from "../queue/types";
import {
  EvmChainName,
  deriveEvmAgentAddress,
  signAndBroadcastEvmTx,
  getEvmTokenBalance,
} from "../utils/evmChains";
import { ensureErc20Allowance } from "../utils/evmLending";
import { flowRegistry } from "./registry";
import { requireUserDestination } from "../utils/authorization";
import type { FlowDefinition, FlowResult } from "./types";

// ─── Morpho Blue Singleton ──────────────────────────────────────────────────────

/** Same address on all chains */
const MORPHO_BLUE_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const MORPHO_SUPPORTED_CHAINS: EvmChainName[] = ["ethereum", "base"];

// ─── Minimal ABI ────────────────────────────────────────────────────────────────

const MORPHO_ABI = [
  {
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "marketParams",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "assets", type: "uint256" },
      { name: "shares", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [
      { name: "assetsSupplied", type: "uint256" },
      { name: "sharesSupplied", type: "uint256" },
    ],
  },
] as const;

// ─── Flow Definition ────────────────────────────────────────────────────────────

const morphoDepositFlow: FlowDefinition<MorphoDepositMetadata> = {
  action: "morpho-deposit",
  name: "Morpho Blue Deposit",
  description: "Supply tokens to a Morpho Blue market on Ethereum or Base",

  supportedChains: {
    source: ["near", "ethereum", "base", "arbitrum", "solana"],
    destination: ["ethereum", "base"],
  },

  requiredMetadataFields: ["action", "marketId", "loanToken", "collateralToken", "oracle", "irm", "lltv"],
  optionalMetadataFields: [],

  isMatch: (intent): intent is ValidatedIntent & { metadata: MorphoDepositMetadata } => {
    const meta = intent.metadata as MorphoDepositMetadata | undefined;
    return (
      meta?.action === "morpho-deposit" &&
      !!meta.marketId &&
      !!meta.loanToken &&
      MORPHO_SUPPORTED_CHAINS.includes(intent.destinationChain as EvmChainName)
    );
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "Morpho deposit");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config: appConfig, logger } = ctx;
    const meta = intent.metadata;
    const chain = intent.destinationChain as EvmChainName;

    if (appConfig.dryRunSwaps) {
      return { txId: `dry-run-morpho-deposit-${intent.intentId}` };
    }

    // 1. Derive agent EVM address
    const agentAddress = await deriveEvmAgentAddress(intent.userDestination);
    logger.info(`[morphoDeposit] Agent address derived`, { chain, agentAddress });

    // 2. Extract loan token address from finalAsset
    const loanTokenAddress = extractEvmTokenAddress(intent.finalAsset);
    logger.info(`[morphoDeposit] Loan token address`, { chain, loanTokenAddress });

    // 3. Check agent's ERC-20 balance
    const balance = await getEvmTokenBalance(chain, loanTokenAddress, agentAddress);
    if (balance <= 0n) {
      throw new Error(`[morphoDeposit] No token balance on ${chain} for ${loanTokenAddress}`);
    }
    logger.info(`[morphoDeposit] Token balance: ${balance.toString()}`, { chain });

    // 4. Approve Morpho singleton to spend tokens
    const txIds: string[] = [];
    const approveTx = await ensureErc20Allowance(
      chain,
      loanTokenAddress,
      agentAddress,
      MORPHO_BLUE_ADDRESS,
      balance,
      intent.userDestination,
      logger,
    );
    if (approveTx) {
      txIds.push(approveTx);
    }

    // 5. Build MarketParams struct and call supply
    const marketParams = {
      loanToken: meta.loanToken as `0x${string}`,
      collateralToken: meta.collateralToken as `0x${string}`,
      oracle: meta.oracle as `0x${string}`,
      irm: meta.irm as `0x${string}`,
      lltv: BigInt(meta.lltv),
    };

    const supplyData = encodeFunctionData({
      abi: MORPHO_ABI,
      functionName: "supply",
      args: [
        marketParams,
        balance,      // assets
        0n,           // shares = 0 (supply by asset amount)
        agentAddress as `0x${string}`, // onBehalfOf
        "0x",         // data (empty callback)
      ],
    });

    const supplyTxHash = await signAndBroadcastEvmTx(
      chain,
      {
        from: agentAddress,
        to: MORPHO_BLUE_ADDRESS,
        data: supplyData,
      },
      intent.userDestination,
    );
    txIds.push(supplyTxHash);

    logger.info(`[morphoDeposit] Supply tx confirmed: ${supplyTxHash}`, { chain });

    return {
      txId: supplyTxHash,
      txIds,
      swappedAmount: balance.toString(),
    };
  },
};

// ─── Self-Registration ──────────────────────────────────────────────────────────

flowRegistry.register(morphoDepositFlow);

// ─── Exports ────────────────────────────────────────────────────────────────────

export { morphoDepositFlow };
