import { encodeFunctionData } from "viem";
import { extractEvmTokenAddress } from "../constants";
import { AaveDepositMetadata, ValidatedIntent } from "../queue/types";
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
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

// ─── Flow Definition ────────────────────────────────────────────────────────────

const aaveDepositFlow: FlowDefinition<AaveDepositMetadata> = {
  action: "aave-deposit",
  name: "Aave V3 Deposit",
  description: "Deposit tokens into Aave V3 lending pool on Ethereum, Base, or Arbitrum",

  supportedChains: {
    source: ["near", "ethereum", "base", "arbitrum", "solana"],
    destination: ["ethereum", "base", "arbitrum"],
  },

  requiredMetadataFields: ["action"],
  optionalMetadataFields: [],

  isMatch: (intent): intent is ValidatedIntent & { metadata: AaveDepositMetadata } => {
    const meta = intent.metadata as AaveDepositMetadata | undefined;
    return (
      meta?.action === "aave-deposit" &&
      AAVE_SUPPORTED_CHAINS.includes(intent.destinationChain as EvmChainName)
    );
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "Aave deposit");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config: appConfig, logger } = ctx;
    const chain = intent.destinationChain as EvmChainName;

    if (appConfig.dryRunSwaps) {
      return { txId: `dry-run-aave-deposit-${intent.intentId}` };
    }

    // 1. Derive agent EVM address
    const agentAddress = await deriveEvmAgentAddress(intent.userDestination);
    logger.info(`[aaveDeposit] Agent address derived`, { chain, agentAddress });

    // 2. Extract token address from finalAsset
    const tokenAddress = extractEvmTokenAddress(intent.finalAsset);
    logger.info(`[aaveDeposit] Token address`, { chain, tokenAddress });

    // 3. Check agent's ERC-20 balance
    const balance = await getEvmTokenBalance(chain, tokenAddress, agentAddress);
    if (balance <= 0n) {
      throw new Error(`[aaveDeposit] No token balance on ${chain} for ${tokenAddress}`);
    }
    logger.info(`[aaveDeposit] Token balance: ${balance.toString()}`, { chain });

    // 4. Get pool address
    const poolAddress = AAVE_POOL_ADDRESSES[chain];
    if (!poolAddress) {
      throw new Error(`[aaveDeposit] No Aave V3 pool address for chain ${chain}`);
    }

    // 5. Approve pool to spend tokens
    const txIds: string[] = [];
    const approveTx = await ensureErc20Allowance(
      chain,
      tokenAddress,
      agentAddress,
      poolAddress,
      balance,
      intent.userDestination,
      logger,
    );
    if (approveTx) {
      txIds.push(approveTx);
    }

    // 6. Call Pool.supply(asset, amount, onBehalfOf, referralCode)
    const supplyData = encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: "supply",
      args: [
        tokenAddress as `0x${string}`,
        balance,
        agentAddress as `0x${string}`,
        0,
      ],
    });

    const supplyTxHash = await signAndBroadcastEvmTx(
      chain,
      {
        from: agentAddress,
        to: poolAddress,
        data: supplyData,
      },
      intent.userDestination,
    );
    txIds.push(supplyTxHash);

    logger.info(`[aaveDeposit] Supply tx confirmed: ${supplyTxHash}`, { chain });

    return {
      txId: supplyTxHash,
      txIds,
      swappedAmount: balance.toString(),
    };
  },
};

// ─── Self-Registration ──────────────────────────────────────────────────────────

flowRegistry.register(aaveDepositFlow);

// ─── Exports ────────────────────────────────────────────────────────────────────

export { aaveDepositFlow };
