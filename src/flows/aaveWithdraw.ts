import { encodeFunctionData, maxUint256 } from "viem";
import { AaveWithdrawMetadata, ValidatedIntent } from "../queue/types";
import {
  EvmChainName,
  deriveEvmAgentAddress,
  signAndBroadcastEvmTx,
} from "../utils/evmChains";
import { transferEvmTokensToUser, executeEvmBridgeBack } from "../utils/evmLending";
import { requireUserDestination } from "../utils/authorization";
import type { FlowDefinition, FlowResult } from "./types";

// ─── Aave V3 Pool Addresses ────────────────────────────────────────────────────

const AAVE_POOL_ADDRESSES: Partial<Record<EvmChainName, string>> = {
  ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
};

const AAVE_SUPPORTED_CHAINS: EvmChainName[] = ["ethereum", "base", "arbitrum"];

// ─── Minimal ABI ────────────────────────────────────────────────────────────────

const AAVE_POOL_ABI = [
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ─── Flow Definition ────────────────────────────────────────────────────────────

const aaveWithdrawFlow: FlowDefinition<AaveWithdrawMetadata> = {
  action: "aave-withdraw",
  name: "Aave V3 Withdraw",
  description: "Withdraw tokens from Aave V3 lending pool on Ethereum, Base, or Arbitrum",

  supportedChains: {
    source: ["ethereum", "base", "arbitrum"],
    destination: ["ethereum", "base", "arbitrum", "near", "solana"],
  },

  requiredMetadataFields: ["action", "underlyingAsset"],
  optionalMetadataFields: ["bridgeBack"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: AaveWithdrawMetadata } => {
    const meta = intent.metadata as AaveWithdrawMetadata | undefined;
    return (
      meta?.action === "aave-withdraw" &&
      !!meta.underlyingAsset &&
      AAVE_SUPPORTED_CHAINS.includes(intent.sourceChain as EvmChainName)
    );
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "Aave withdraw");

    if (!intent.userSignature) {
      throw new Error("Aave withdraw requires userSignature for authorization");
    }
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config: appConfig, logger } = ctx;
    const meta = intent.metadata;
    const chain = intent.sourceChain as EvmChainName;

    if (appConfig.dryRunSwaps) {
      const result: FlowResult = { txId: `dry-run-aave-withdraw-${intent.intentId}` };
      if (meta.bridgeBack) {
        result.bridgeTxId = `dry-run-bridge-${intent.intentId}`;
        result.intentsDepositAddress = "dry-run-deposit-address";
      }
      return result;
    }

    // 1. Derive agent EVM address
    const agentAddress = await deriveEvmAgentAddress(intent.userDestination);
    logger.info(`[aaveWithdraw] Agent address derived`, { chain, agentAddress });

    // 2. Get pool address
    const poolAddress = AAVE_POOL_ADDRESSES[chain];
    if (!poolAddress) {
      throw new Error(`[aaveWithdraw] No Aave V3 pool address for chain ${chain}`);
    }

    // 3. Call Pool.withdraw(asset, type(uint256).max, to=agent) to withdraw full position
    const withdrawData = encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: "withdraw",
      args: [
        meta.underlyingAsset as `0x${string}`,
        maxUint256,
        agentAddress as `0x${string}`,
      ],
    });

    const withdrawTxHash = await signAndBroadcastEvmTx(
      chain,
      {
        from: agentAddress,
        to: poolAddress,
        data: withdrawData,
      },
      intent.userDestination,
    );

    logger.info(`[aaveWithdraw] Withdraw tx confirmed: ${withdrawTxHash}`, { chain });

    // 4. Bridge back or transfer to user
    if (meta.bridgeBack) {
      const bridgeResult = await executeEvmBridgeBack(
        chain,
        meta.underlyingAsset,
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
      meta.underlyingAsset,
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

export { aaveWithdrawFlow };
