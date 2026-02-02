/**
 * Shared EVM lending utilities for Aave V3 and Morpho Blue flows.
 * Extracts common patterns (allowance, transfer, bridgeBack) from evmSwap.ts.
 */

import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { ETH_NATIVE_TOKEN } from "../constants";
import {
  EvmChainName,
  signAndBroadcastEvmTx,
  getEvmTokenAllowance,
  getEvmTokenBalance,
  getEvmNativeBalance,
  EVM_CHAIN_CONFIGS,
} from "./evmChains";
import { getIntentsQuote, createBridgeBackQuoteRequest, BridgeBackConfig } from "./intents";
import type { Logger, AppConfig } from "../flows/types";

// ─── Allowance ──────────────────────────────────────────────────────────────────

/**
 * Ensures the agent has sufficient ERC-20 allowance for a spender.
 * If not, sends an approve(MAX_UINT256) transaction.
 *
 * @returns The approve txHash if approval was needed, null otherwise.
 */
export async function ensureErc20Allowance(
  chain: EvmChainName,
  token: string,
  owner: string,
  spender: string,
  amount: bigint,
  userDestination: string,
  logger: Logger,
): Promise<string | null> {
  const currentAllowance = await getEvmTokenAllowance(chain, token, owner, spender);
  if (currentAllowance >= amount) {
    logger.debug(`[evmLending] Allowance sufficient`, {
      chain,
      token,
      currentAllowance: currentAllowance.toString(),
      required: amount.toString(),
    });
    return null;
  }

  logger.info(`[evmLending] Approving token`, {
    chain,
    token,
    spender,
    currentAllowance: currentAllowance.toString(),
  });

  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender as `0x${string}`, maxUint256],
  });

  const txHash = await signAndBroadcastEvmTx(
    chain,
    {
      from: owner,
      to: token,
      data: approveData,
    },
    userDestination,
  );

  logger.info(`[evmLending] Approve tx confirmed: ${txHash}`, { chain });
  return txHash;
}

// ─── Transfer ───────────────────────────────────────────────────────────────────

/**
 * Transfers ERC-20 tokens (or native balance) from agent to user destination address.
 */
export async function transferEvmTokensToUser(
  chain: EvmChainName,
  token: string,
  agentAddress: string,
  userDestination: string,
  logger: Logger,
): Promise<string> {
  const isNative =
    token.toLowerCase() === ETH_NATIVE_TOKEN.toLowerCase() ||
    token === "0x0000000000000000000000000000000000000000";

  if (isNative) {
    const balance = await getEvmNativeBalance(chain, agentAddress);
    const gasBuffer = BigInt(100_000) * BigInt(30_000_000_000); // ~0.003 ETH
    const transferAmount = balance > gasBuffer ? balance - gasBuffer : 0n;

    if (transferAmount <= 0n) {
      throw new Error(`[evmLending] Insufficient native balance for transfer on ${chain}`);
    }

    logger.info(`[evmLending] Transferring native tokens to user`, {
      chain,
      amount: transferAmount.toString(),
      to: userDestination,
    });

    return signAndBroadcastEvmTx(
      chain,
      {
        from: agentAddress,
        to: userDestination,
        value: `0x${transferAmount.toString(16)}`,
      },
      userDestination,
    );
  }

  // ERC-20 transfer
  const balance = await getEvmTokenBalance(chain, token, agentAddress);
  if (balance <= 0n) {
    throw new Error(`[evmLending] No ERC-20 balance to transfer on ${chain}`);
  }

  logger.info(`[evmLending] Transferring ERC-20 to user`, {
    chain,
    token,
    amount: balance.toString(),
    to: userDestination,
  });

  const transferData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [userDestination as `0x${string}`, balance],
  });

  return signAndBroadcastEvmTx(
    chain,
    {
      from: agentAddress,
      to: token,
      data: transferData,
    },
    userDestination,
  );
}

// ─── Bridge Back ────────────────────────────────────────────────────────────────

/**
 * Bridge ERC-20 tokens back to the user's source chain via Defuse Intents.
 * Gets a deposit address from OneClick, then transfers tokens to it.
 *
 * @returns Object with the transfer txHash and the Defuse deposit address.
 */
export async function executeEvmBridgeBack(
  chain: EvmChainName,
  token: string,
  agentAddress: string,
  userDestination: string,
  bridgeBack: BridgeBackConfig,
  amount: string,
  config: AppConfig,
  logger: Logger,
): Promise<{ txId: string; depositAddress: string }> {
  const chainConfig = EVM_CHAIN_CONFIGS[chain];

  // Determine origin asset ID for Defuse
  // For now use the chain's native Defuse asset ID if token is native,
  // otherwise construct the nep141 format
  const originAsset = chainConfig.nativeDefuseAssetId;

  const quoteRequest = createBridgeBackQuoteRequest(
    bridgeBack,
    originAsset,
    amount,
    userDestination,
  );

  logger.info(`[evmLending] Getting bridge-back deposit address`, {
    chain,
    destinationChain: bridgeBack.destinationChain,
    destinationAsset: bridgeBack.destinationAsset,
    amount,
  });

  const { depositAddress } = await getIntentsQuote(quoteRequest, config);

  logger.info(`[evmLending] Bridge-back deposit address: ${depositAddress}`, { chain });

  // Transfer tokens to the deposit address
  const balance = await getEvmTokenBalance(chain, token, agentAddress);
  if (balance <= 0n) {
    throw new Error(`[evmLending] No ERC-20 balance for bridge-back on ${chain}`);
  }

  const transferData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [depositAddress as `0x${string}`, balance],
  });

  const txHash = await signAndBroadcastEvmTx(
    chain,
    {
      from: agentAddress,
      to: token,
      data: transferData,
    },
    userDestination,
  );

  logger.info(`[evmLending] Bridge-back transfer tx confirmed: ${txHash}`, { chain });

  return { txId: txHash, depositAddress };
}
