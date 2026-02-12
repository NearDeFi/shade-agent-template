import { encodeFunctionData } from "viem";
import { MorphoWithdrawMetadata, ValidatedIntent } from "../queue/types";
import {
  EvmChainName,
  deriveEvmAgentAddress,
  signAndBroadcastEvmTx,
} from "../utils/evmChains";
import { transferEvmTokensToUser, executeEvmBridgeBack, MORPHO_BLUE_ADDRESS, MORPHO_SUPPORTED_CHAINS } from "../utils/evmLending";
import { requireUserDestination } from "../utils/authorization";
import { dryRunResult } from "./context";
import type { FlowDefinition, FlowResult } from "./types";

// ─── Minimal ABI ────────────────────────────────────────────────────────────────

const MORPHO_ABI = [
  {
    name: "withdraw",
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
      { name: "receiver", type: "address" },
    ],
    outputs: [
      { name: "assetsWithdrawn", type: "uint256" },
      { name: "sharesWithdrawn", type: "uint256" },
    ],
  },
  {
    name: "position",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
  },
] as const;

// ─── Flow Definition ────────────────────────────────────────────────────────────

const morphoWithdrawFlow: FlowDefinition<MorphoWithdrawMetadata> = {
  action: "morpho-withdraw",
  name: "Morpho Blue Withdraw",
  description: "Withdraw supplied tokens from a Morpho Blue market on Ethereum or Base",

  supportedChains: {
    source: ["ethereum", "base"],
    destination: ["ethereum", "base", "near", "solana"],
  },

  requiredMetadataFields: ["action", "marketId", "loanToken", "collateralToken", "oracle", "irm", "lltv"],
  optionalMetadataFields: ["bridgeBack"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: MorphoWithdrawMetadata } => {
    const meta = intent.metadata as MorphoWithdrawMetadata | undefined;
    return (
      meta?.action === "morpho-withdraw" &&
      !!meta.marketId &&
      !!meta.loanToken &&
      MORPHO_SUPPORTED_CHAINS.includes(intent.sourceChain as EvmChainName)
    );
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "Morpho withdraw");

    if (!intent.userSignature) {
      throw new Error("Morpho withdraw requires userSignature for authorization");
    }
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config: appConfig, logger } = ctx;
    const meta = intent.metadata;
    const chain = intent.sourceChain as EvmChainName;

    const dry = dryRunResult("morpho-withdraw", intent.intentId, appConfig, { bridgeBack: !!meta.bridgeBack });
    if (dry) return dry;

    // 1. Derive agent EVM address
    const agentAddress = await deriveEvmAgentAddress(intent.userDestination);
    logger.info(`[morphoWithdraw] Agent address derived`, { chain, agentAddress });

    // 2. Build MarketParams struct
    const marketParams = {
      loanToken: meta.loanToken as `0x${string}`,
      collateralToken: meta.collateralToken as `0x${string}`,
      oracle: meta.oracle as `0x${string}`,
      irm: meta.irm as `0x${string}`,
      lltv: BigInt(meta.lltv),
    };

    // 3. Query current position to get supplyShares for max withdrawal
    const { getEvmPublicClient } = await import("../utils/evmChains");
    const client = getEvmPublicClient(chain);
    const position = await client.readContract({
      address: MORPHO_BLUE_ADDRESS as `0x${string}`,
      abi: MORPHO_ABI,
      functionName: "position",
      args: [meta.marketId as `0x${string}`, agentAddress as `0x${string}`],
    });

    const supplyShares = position[0]; // supplyShares is the first return value
    if (supplyShares <= 0n) {
      throw new Error(`[morphoWithdraw] No supply position in market ${meta.marketId}`);
    }

    logger.info(`[morphoWithdraw] Current supply shares: ${supplyShares.toString()}`, { chain });

    // 4. Call Morpho.withdraw(marketParams, assets=0, shares=maxShares, onBehalfOf=agent, receiver=agent)
    const withdrawData = encodeFunctionData({
      abi: MORPHO_ABI,
      functionName: "withdraw",
      args: [
        marketParams,
        0n,           // assets = 0 (withdraw by shares)
        supplyShares, // withdraw all supply shares
        agentAddress as `0x${string}`,
        agentAddress as `0x${string}`,
      ],
    });

    const withdrawTxHash = await signAndBroadcastEvmTx(
      chain,
      {
        from: agentAddress,
        to: MORPHO_BLUE_ADDRESS,
        data: withdrawData,
      },
      intent.userDestination,
    );

    logger.info(`[morphoWithdraw] Withdraw tx confirmed: ${withdrawTxHash}`, { chain });

    // 5. Bridge back or transfer to user
    if (meta.bridgeBack) {
      const bridgeResult = await executeEvmBridgeBack(
        chain,
        meta.loanToken,
        agentAddress,
        intent.userDestination,
        meta.bridgeBack,
        intent.sourceAmount,
        appConfig,
        logger,
      );
      return {
        txId: withdrawTxHash,
        bridgeTxId: bridgeResult.txId,
        intentsDepositAddress: bridgeResult.depositAddress,
      };
    }

    // Transfer withdrawn tokens directly to user on the same chain
    const transferTxHash = await transferEvmTokensToUser(
      chain,
      meta.loanToken,
      agentAddress,
      intent.userDestination,
      logger,
    );

    return {
      txId: withdrawTxHash,
      txIds: [withdrawTxHash, transferTxHash],
    };
  },
};

// ─── Exports ────────────────────────────────────────────────────────────────────

export { morphoWithdrawFlow };
