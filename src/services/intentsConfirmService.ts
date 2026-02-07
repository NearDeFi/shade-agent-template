import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AppError } from "../errors/appError";
import { NEAR_DEFAULT_PATH } from "../utils/chainSignature";
import {
  deriveNearAgentAccount,
  getNearTransactionStatus,
} from "../utils/near";
import { deriveAgentPublicKey, getSolanaConnection } from "../utils/solana";
import { createLogger } from "../utils/logger";
import type { IntentValidator } from "../queue/validation";
import { queueClient } from "../queue/client";
import {
  getStatus,
  setStatus,
  transitionStatus,
  type IntentStatus,
} from "../state/status";
import { intentValidator as sharedIntentValidator } from "../queue/flowCatalog";

const log = createLogger("intents/confirmService");

function getAccountAddresses(txInfo: any): string[] {
  const accountKeys = txInfo.transaction.message.getAccountKeys();
  const accountAddresses: string[] = [];
  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys.get(i);
    if (key) accountAddresses.push(key.toBase58());
  }
  return accountAddresses;
}

function getSignerAddresses(txInfo: any): string[] {
  const accountKeys = txInfo.transaction.message.getAccountKeys();
  const requiredSignatures =
    txInfo.transaction.message.header?.numRequiredSignatures ?? 0;
  const signers: string[] = [];
  for (let i = 0; i < requiredSignatures; i++) {
    const key = accountKeys.get(i);
    if (key) signers.push(key.toBase58());
  }
  return signers;
}

function getTokenDeltaForAccountMint(
  txInfo: any,
  accountAddress: string,
  mintAddress: string,
): bigint {
  const accountKeys = txInfo.transaction.message.getAccountKeys();
  let accountIndex = -1;
  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys.get(i);
    if (key?.toBase58() === accountAddress) {
      accountIndex = i;
      break;
    }
  }

  if (accountIndex === -1) return 0n;

  const pre = (txInfo.meta?.preTokenBalances ?? []).find(
    (b: any) => b.accountIndex === accountIndex && b.mint === mintAddress,
  );
  const post = (txInfo.meta?.postTokenBalances ?? []).find(
    (b: any) => b.accountIndex === accountIndex && b.mint === mintAddress,
  );

  const preAmount = BigInt(pre?.uiTokenAmount?.amount ?? "0");
  const postAmount = BigInt(post?.uiTokenAmount?.amount ?? "0");
  return postAmount - preAmount;
}

async function loadAwaitingIntent(intentId: string): Promise<IntentStatus> {
  const status = await getStatus(intentId);
  if (!status) {
    throw new AppError("not_found", "Intent not found");
  }
  if (status.state !== "awaiting_user_tx") {
    throw new AppError(
      "conflict",
      `Intent is in state '${status.state}', expected 'awaiting_user_tx'`,
    );
  }
  if (!status.intentData) {
    throw new AppError("internal_error", "Intent data missing from status");
  }
  return status;
}

async function claimConfirmLock(intentId: string, intentData: NonNullable<IntentStatus["intentData"]>) {
  const transition = await transitionStatus(intentId, "awaiting_user_tx", {
    state: "processing",
    detail: "Confirming user transaction",
    intentData,
  });

  if (!transition.updated) {
    const latestState = transition.currentStatus?.state ?? "unknown";
    throw new AppError(
      "conflict",
      `Intent is in state '${latestState}', expected 'awaiting_user_tx'`,
    );
  }
}

async function enqueueConfirmedIntent(
  intentId: string,
  intentData: NonNullable<IntentStatus["intentData"]>,
  detail: string,
  validateIntentFn: IntentValidator,
) {
  try {
    const validatedIntent = validateIntentFn(intentData);
    await queueClient.enqueueIntent(validatedIntent);
    await setStatus(intentId, {
      state: "processing",
      detail,
      intentData: validatedIntent,
    });
  } catch (err) {
    throw new AppError("internal_error", "Failed to enqueue intent", { cause: err });
  }
}

async function verifyNearAndEnqueue(
  intentId: string,
  txHash: string,
  intentData: NonNullable<IntentStatus["intentData"]>,
  validateIntentFn: IntentValidator,
) {
  const meta = (intentData.metadata ?? {}) as Record<string, unknown>;
  const userNearAddress = meta.userNearAddress as string | undefined;
  if (!userNearAddress) {
    throw new AppError("internal_error", "Missing userNearAddress in intent metadata");
  }

  let txResult;
  try {
    txResult = await getNearTransactionStatus(txHash, userNearAddress);
  } catch (err) {
    log.error("Failed to fetch NEAR transaction", { txHash, err: String(err) });
    throw new AppError("upstream_error", "Failed to verify NEAR transaction on-chain", { cause: err });
  }

  if (!txResult.success) {
    throw new AppError("invalid_request", "NEAR transaction failed on-chain");
  }

  const agentAccount = await deriveNearAgentAccount(NEAR_DEFAULT_PATH, userNearAddress);
  const agentNearAddress = agentAccount.accountId;

  const hasFtTransfer = txResult.actions.some((a) => {
    const isFtMethod = a.methodName === "ft_transfer" || a.methodName === "ft_transfer_call";
    const toAgent = a.args?.receiver_id === agentNearAddress;
    return isFtMethod && toAgent;
  });

  if (!hasFtTransfer) {
    log.warn("NEAR TX is not an ft_transfer to agent", {
      intentId,
      txHash,
      agentNearAddress,
      receiverId: txResult.receiverId,
      actions: txResult.actions,
    });
    throw new AppError(
      "forbidden",
      "Transaction is not an ft_transfer to the expected agent address",
    );
  }

  meta.userTxHash = txHash;
  meta.userTxConfirmed = true;
  intentData.metadata = meta;
  await enqueueConfirmedIntent(
    intentId,
    intentData,
    "NEAR transaction confirmed, bridge-out in progress",
    validateIntentFn,
  );

  log.info("NEAR sell intent confirmed and enqueued", {
    intentId,
    txHash,
    agentNearAddress,
  });
}

async function verifySolanaAndEnqueue(
  intentId: string,
  txHash: string,
  intentData: NonNullable<IntentStatus["intentData"]>,
  validateIntentFn: IntentValidator,
) {
  const meta = (intentData.metadata ?? {}) as Record<string, unknown>;
  const userSourceAddress = meta.userSourceAddress as string | undefined;
  if (!userSourceAddress) {
    throw new AppError("internal_error", "Missing userSourceAddress in intent metadata");
  }

  let normalizedUserSourceAddress: string;
  try {
    normalizedUserSourceAddress = new PublicKey(userSourceAddress).toBase58();
  } catch {
    throw new AppError("internal_error", "Invalid userSourceAddress in intent metadata");
  }

  const connection = getSolanaConnection();
  let txInfo;
  try {
    txInfo = await connection.getTransaction(txHash, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    log.error("Failed to fetch transaction", { txHash, err: String(err) });
    throw new AppError("upstream_error", "Failed to verify transaction on-chain", { cause: err });
  }

  if (!txInfo) {
    throw new AppError(
      "not_found",
      "Transaction not found on-chain. It may not be confirmed yet.",
    );
  }

  if (txInfo.meta?.err) {
    throw new AppError(
      "invalid_request",
      `Transaction failed on-chain: ${JSON.stringify(txInfo.meta.err)}`,
    );
  }

  const signerAddresses = getSignerAddresses(txInfo);
  if (!signerAddresses.includes(normalizedUserSourceAddress)) {
    log.warn("User source address is not a signer for confirmed sell transaction", {
      intentId,
      txHash,
      userSourceAddress: normalizedUserSourceAddress,
      signers: signerAddresses,
    });
    throw new AppError(
      "forbidden",
      "Transaction was not signed by the expected user source address",
    );
  }

  const agentPubkey = await deriveAgentPublicKey(undefined, userSourceAddress);
  const agentAddress = agentPubkey.toBase58();
  const accountAddresses = getAccountAddresses(txInfo);
  const agentWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    agentPubkey,
    true,
    TOKEN_PROGRAM_ID,
  );

  const agentWsolAtaAddress = agentWsolAta.toBase58();
  if (!accountAddresses.includes(agentWsolAtaAddress)) {
    log.warn("Expected agent wSOL ATA not found in transaction account keys", {
      intentId,
      txHash,
      agentAddress,
      agentWsolAta: agentWsolAtaAddress,
    });
    throw new AppError(
      "forbidden",
      "Transaction does not involve the expected agent token account",
    );
  }

  const wsolDelta = getTokenDeltaForAccountMint(
    txInfo,
    agentWsolAtaAddress,
    NATIVE_MINT.toBase58(),
  );
  if (wsolDelta <= 0n) {
    log.warn("Confirmed transaction did not credit agent wSOL ATA", {
      intentId,
      txHash,
      agentWsolAta: agentWsolAtaAddress,
      wsolDelta: wsolDelta.toString(),
    });
    throw new AppError(
      "forbidden",
      "Transaction did not transfer output funds to the expected agent token account",
    );
  }

  meta.userTxHash = txHash;
  meta.userTxConfirmed = true;
  intentData.metadata = meta;
  await enqueueConfirmedIntent(
    intentId,
    intentData,
    "User transaction confirmed, bridge-out in progress",
    validateIntentFn,
  );

  log.info("Sell intent confirmed and enqueued", {
    intentId,
    txHash,
    agentAddress,
  });
}

export async function confirmIntentUserTransaction(
  intentId: string,
  txHash: string,
  validateIntentFn: IntentValidator = sharedIntentValidator,
) {
  const status = await loadAwaitingIntent(intentId);
  const intentData = status.intentData!;
  await claimConfirmLock(intentId, intentData);

  const rollbackAwaitingUserTx = async (detail: string) => {
    try {
      await transitionStatus(intentId, "processing", {
        state: "awaiting_user_tx",
        detail,
        intentData,
      });
    } catch (err) {
      log.error("Failed to restore awaiting_user_tx after confirm error", {
        intentId,
        err: String(err),
      });
    }
  };

  try {
    const meta = (intentData.metadata ?? {}) as Record<string, unknown>;
    if (meta.action === "near-bridge-out") {
      await verifyNearAndEnqueue(intentId, txHash, intentData, validateIntentFn);
    } else {
      await verifySolanaAndEnqueue(intentId, txHash, intentData, validateIntentFn);
    }
  } catch (err) {
    const appErr = err instanceof AppError ? err : new AppError("internal_error", "Failed to confirm transaction", { cause: err });
    await rollbackAwaitingUserTx(appErr.message);
    throw appErr;
  }

  return {
    intentId,
    state: "processing" as const,
    txHash,
  };
}
