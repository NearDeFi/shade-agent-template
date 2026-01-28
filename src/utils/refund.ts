import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import {
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  getSolanaConnection,
  signAndBroadcastSingleSigner,
} from "./solana";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
  executeNearFunctionCall,
  GAS_FOR_FT_TRANSFER_CALL,
  ONE_YOCTO,
  getNearProvider,
} from "./near";
import { extractSolanaMintAddress } from "../constants";

interface Logger {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

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
  const mintAddress = new PublicKey(extractSolanaMintAddress(intermediateAsset));
  const agentPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, userDestination);
  const userPublicKey = new PublicKey(userDestination);

  const connection = getSolanaConnection();
  const agentAta = getAssociatedTokenAddressSync(mintAddress, agentPublicKey);

  let balance: bigint;
  try {
    const account = await getAccount(connection, agentAta);
    balance = account.amount;
  } catch {
    // ATA doesn't exist or has no balance
    return null;
  }

  if (balance <= 0n) {
    logger.info("[refund] No Solana token balance to refund");
    return null;
  }

  logger.info(`[refund] Refunding ${balance} of ${intermediateAsset} to ${userDestination}`);

  const userAta = getAssociatedTokenAddressSync(mintAddress, userPublicKey);

  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      agentPublicKey,
      userAta,
      userPublicKey,
      mintAddress,
    ),
    createTransferInstruction(
      agentAta,
      userAta,
      agentPublicKey,
      balance,
    ),
  ];

  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: agentPublicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);

  if (dryRun) {
    logger.info("[refund] Dry run — skipping broadcast");
    return { txId: `dry-run-refund-sol`, amount: balance.toString() };
  }

  const txId = await signAndBroadcastSingleSigner(transaction, userDestination);
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
    balance = JSON.parse(Buffer.from((result as any).result).toString());
  } catch {
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
