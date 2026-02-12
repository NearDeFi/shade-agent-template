import { address, type IInstruction } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  fetchToken,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  getSolanaRpc,
  signAndBroadcastSingleSigner,
  buildAndCompileTransaction,
} from "./solana";
import { createDummySigner } from "./chainSignature";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
  executeNearFunctionCall,
  GAS_FOR_FT_TRANSFER_CALL,
  ONE_YOCTO,
  getNearProvider,
} from "./near";
import { extractSolanaMintAddress, extractEvmTokenAddress, ETH_NATIVE_TOKEN, EVM_GAS_BUFFER } from "../constants";
import {
  EvmChainName,
  deriveEvmAgentAddress,
  signAndBroadcastEvmTx,
  getEvmNativeBalance,
  getEvmTokenBalance,
} from "./evmChains";
import { encodeFunctionData, erc20Abi } from "viem";
import type { Logger } from "./logger";

/**
 * Refund Solana SPL tokens from the agent's derived wallet to the user.
 *
 * Derives the agent wallet using `userDestination` as the derivation suffix,
 * queries the token balance in the agent's ATA, and if > 0 transfers to the
 * user's wallet.
 *
 * @returns `{ txId, amount }` if a transfer was made, `null` if no balance.
 */
export async function refundSolanaTokensToUser(
  intermediateAsset: string,
  userDestination: string,
  logger: Logger,
  dryRun: boolean,
): Promise<{ txId: string; amount: string } | null> {
  const mintAddr = address(extractSolanaMintAddress(intermediateAsset));
  const agentAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, userDestination);
  const userAddr = address(userDestination);

  const rpc = getSolanaRpc();

  const [agentAta] = await findAssociatedTokenPda({
    mint: mintAddr,
    owner: agentAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  let balance: bigint;
  try {
    const account = await fetchToken(rpc, agentAta);
    balance = account.data.amount;
  } catch {
    // ATA doesn't exist or has no balance — expected for new accounts
    logger.debug("[refund] Solana ATA not found, no balance to refund");
    return null;
  }

  if (balance <= 0n) {
    logger.info("[refund] No Solana token balance to refund");
    return null;
  }

  logger.info(`[refund] Refunding ${balance} of ${intermediateAsset} to ${userDestination}`);

  const [userAta] = await findAssociatedTokenPda({
    mint: mintAddr,
    owner: userAddr,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const instructions: IInstruction[] = [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: createDummySigner(address(agentAddress)),
      ata: userAta,
      owner: userAddr,
      mint: mintAddr,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }) as IInstruction,
    getTransferInstruction({
      source: agentAta,
      destination: userAta,
      authority: createDummySigner(agentAddress),
      amount: balance,
    }) as IInstruction,
  ];

  const compiledTx = await buildAndCompileTransaction({
    instructions,
    feePayer: agentAddress,
    rpc,
  });

  if (dryRun) {
    logger.info("[refund] Dry run — skipping broadcast");
    return { txId: `dry-run-refund-sol`, amount: balance.toString() };
  }

  const txId = await signAndBroadcastSingleSigner(compiledTx, userDestination);
  logger.info(`[refund] Solana refund broadcast: ${txId}`);
  return { txId, amount: balance.toString() };
}

/**
 * Refund NEAR fungible tokens from the agent's derived wallet to the user.
 *
 * Derives the agent wallet using `userDestination` as the derivation suffix,
 * queries the ft_balance_of the agent account, and if > 0 sends an
 * ft_transfer to the user.
 *
 * @returns `{ txId, amount }` if a transfer was made, `null` if no balance.
 */
export async function refundNearTokensToUser(
  intermediateAsset: string,
  userDestination: string,
  logger: Logger,
  dryRun: boolean,
): Promise<{ txId: string; amount: string } | null> {
  const agentAccount = await deriveNearAgentAccount(undefined, userDestination);
  const provider = getNearProvider();

  let balance: string;
  try {
    const result = await provider.query({
      request_type: "call_function",
      finality: "final",
      account_id: intermediateAsset,
      method_name: "ft_balance_of",
      args_base64: Buffer.from(
        JSON.stringify({ account_id: agentAccount.accountId }),
      ).toString("base64"),
    });
    balance = JSON.parse(Buffer.from((result as unknown as { result: number[] }).result).toString());
  } catch (err) {
    logger.info(`[refund] NEAR ft_balance_of query failed (expected for new accounts)`, { err: String(err) });
    return null;
  }

  if (balance === "0" || BigInt(balance) <= 0n) {
    logger.info("[refund] No NEAR token balance to refund");
    return null;
  }

  logger.info(`[refund] Refunding ${balance} of ${intermediateAsset} to ${userDestination}`);

  await ensureNearAccountFunded(agentAccount.accountId);

  if (dryRun) {
    logger.info("[refund] Dry run — skipping broadcast");
    return { txId: `dry-run-refund-near`, amount: balance };
  }

  const txId = await executeNearFunctionCall({
    from: agentAccount,
    receiverId: intermediateAsset,
    methodName: "ft_transfer",
    args: {
      receiver_id: userDestination,
      amount: balance,
      memo: "Auto-refund of intermediate tokens after swap failure",
    },
    gas: GAS_FOR_FT_TRANSFER_CALL,
    deposit: ONE_YOCTO,
  });

  logger.info(`[refund] NEAR refund broadcast: ${txId}`);
  return { txId, amount: balance };
}

/**
 * Refund EVM tokens from the agent's derived wallet to the user.
 *
 * Derives the agent wallet using `userDestination` as the derivation suffix,
 * queries the balance (native or ERC-20), and if > 0 transfers to the user.
 *
 * @returns `{ txId, amount }` if a transfer was made, `null` if no balance.
 */
export async function refundEvmTokensToUser(
  chain: EvmChainName,
  intermediateAsset: string,
  userDestination: string,
  logger: Logger,
  dryRun: boolean,
): Promise<{ txId: string; amount: string } | null> {
  const agentAddress = await deriveEvmAgentAddress(userDestination);
  const tokenAddress = extractEvmTokenAddress(intermediateAsset);

  const isNative =
    tokenAddress.toLowerCase() === ETH_NATIVE_TOKEN.toLowerCase() ||
    tokenAddress === "0x0000000000000000000000000000000000000000";

  let balance: bigint;
  if (isNative) {
    balance = await getEvmNativeBalance(chain, agentAddress);
    balance = balance > EVM_GAS_BUFFER ? balance - EVM_GAS_BUFFER : 0n;
  } else {
    balance = await getEvmTokenBalance(chain, tokenAddress, agentAddress);
  }

  if (balance <= 0n) {
    logger.info(`[refund] No EVM token balance to refund on ${chain}`);
    return null;
  }

  logger.info(`[refund] Refunding ${balance} of ${intermediateAsset} on ${chain} to ${userDestination}`);

  if (dryRun) {
    logger.info("[refund] Dry run — skipping broadcast");
    return { txId: `dry-run-refund-evm-${chain}`, amount: balance.toString() };
  }

  let txHash: string;
  if (isNative) {
    txHash = await signAndBroadcastEvmTx(
      chain,
      {
        from: agentAddress,
        to: userDestination,
        value: `0x${balance.toString(16)}`,
      },
      userDestination,
    );
  } else {
    const transferData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [userDestination as `0x${string}`, balance],
    });

    txHash = await signAndBroadcastEvmTx(
      chain,
      {
        from: agentAddress,
        to: tokenAddress,
        data: transferData,
      },
      userDestination,
    );
  }

  logger.info(`[refund] EVM refund broadcast on ${chain}: ${txHash}`);
  return { txId: txHash, amount: balance.toString() };
}
