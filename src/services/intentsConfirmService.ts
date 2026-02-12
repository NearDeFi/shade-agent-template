import { address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { AppError } from "../errors/appError";
import { NEAR_DEFAULT_PATH } from "../utils/chainSignature";
import {
  deriveNearAgentAccount,
  getNearTransactionStatus,
} from "../utils/near";
import { deriveAgentPublicKey, getSolanaRpc } from "../utils/solana";
import { createLogger } from "../utils/logger";
import type { IntentValidator } from "../queue/validation";
import {
  enqueueIntentWithStatus,
  getStatus,
  transitionStatus,
  type IntentStatus,
} from "../state/status";
import type { IntentMetadata } from "../queue/types";
import { intentValidator as sharedIntentValidator } from "../queue/flowCatalog";

const log = createLogger("intents/confirmService");

interface ConfirmIntentDeps {
  enqueueIntentWithStatusFn?: typeof enqueueIntentWithStatus;
}

/**
 * Kit RPC getTransaction response shape (simplified for our needs).
 * The full type is complex; we extract what we use.
 */
interface KitTransactionResponse {
  transaction: {
    message: {
      accountKeys: string[];
      header: {
        numRequiredSignatures: number;
        numReadonlySignedAccounts: number;
        numReadonlyUnsignedAccounts: number;
      };
    };
  };
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
  } | null;
}

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

function getAccountAddresses(txInfo: KitTransactionResponse): string[] {
  return txInfo.transaction.message.accountKeys;
}

function getSignerAddresses(txInfo: KitTransactionResponse): string[] {
  const accountKeys = txInfo.transaction.message.accountKeys;
  const requiredSignatures =
    txInfo.transaction.message.header?.numRequiredSignatures ?? 0;
  return accountKeys.slice(0, requiredSignatures);
}

function getTokenDeltaForAccountMint(
  txInfo: KitTransactionResponse,
  accountAddress: string,
  mintAddress: string,
): bigint {
  const accountKeys = txInfo.transaction.message.accountKeys;
  const accountIndex = accountKeys.indexOf(accountAddress);

  if (accountIndex === -1) return 0n;

  const pre = (txInfo.meta?.preTokenBalances ?? []).find(
    (b) => b.accountIndex === accountIndex && b.mint === mintAddress,
  );
  const post = (txInfo.meta?.postTokenBalances ?? []).find(
    (b) => b.accountIndex === accountIndex && b.mint === mintAddress,
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
  deps: ConfirmIntentDeps,
) {
  try {
    const validatedIntent = validateIntentFn(intentData);
    await (deps.enqueueIntentWithStatusFn ?? enqueueIntentWithStatus)(validatedIntent, {
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
  deps: ConfirmIntentDeps,
) {
  const meta = (intentData.metadata ?? {}) as Record<string, unknown> & IntentMetadata;
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
    deps,
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
  deps: ConfirmIntentDeps,
) {
  const meta = (intentData.metadata ?? {}) as Record<string, unknown> & IntentMetadata;
  const userSourceAddress = meta.userSourceAddress as string | undefined;
  if (!userSourceAddress) {
    throw new AppError("internal_error", "Missing userSourceAddress in intent metadata");
  }

  // Validate address format by calling address() — throws if invalid
  let normalizedUserSourceAddress: string;
  try {
    normalizedUserSourceAddress = address(userSourceAddress);
  } catch {
    throw new AppError("internal_error", "Invalid userSourceAddress in intent metadata");
  }

  const rpc = getSolanaRpc();
  let txInfo: KitTransactionResponse;
  try {
    // `as any` — Kit expects a branded Signature type, but we have a plain string from the user
    const result = await rpc.getTransaction(txHash as any, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
      // Kit RPC returns JSON-parsed response; request "jsonParsed" for account keys
      encoding: "jsonParsed",
    } as any).send();

    if (!result) {
      throw new AppError(
        "not_found",
        "Transaction not found on-chain. It may not be confirmed yet.",
      );
    }

    // Kit RPC returns the JSON-RPC response directly. The account keys
    // in jsonParsed encoding are in `transaction.message.accountKeys`
    // as an array of objects with `pubkey` field, or as strings depending
    // on the encoding. We normalize to string[].
    const rawAccountKeys = (result as any).transaction?.message?.accountKeys ?? [];
    const accountKeys: string[] = rawAccountKeys.map((k: any) =>
      typeof k === "string" ? k : k.pubkey ?? k,
    );

    txInfo = {
      transaction: {
        message: {
          accountKeys,
          header: (result as any).transaction?.message?.header ?? {
            numRequiredSignatures: 0,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 0,
          },
        },
      },
      meta: (result as any).meta ?? null,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    log.error("Failed to fetch transaction", { txHash, err: String(err) });
    throw new AppError("upstream_error", "Failed to verify transaction on-chain", { cause: err });
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

  const agentAddress = await deriveAgentPublicKey(undefined, userSourceAddress);
  const accountAddresses = getAccountAddresses(txInfo);

  const nativeMintAddr = address("So11111111111111111111111111111111111111112");
  const [agentWsolAta] = await findAssociatedTokenPda({
    mint: nativeMintAddr,
    owner: agentAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  if (!accountAddresses.includes(agentWsolAta)) {
    log.warn("Expected agent wSOL ATA not found in transaction account keys", {
      intentId,
      txHash,
      agentAddress,
      agentWsolAta,
    });
    throw new AppError(
      "forbidden",
      "Transaction does not involve the expected agent token account",
    );
  }

  const wsolDelta = getTokenDeltaForAccountMint(
    txInfo,
    agentWsolAta,
    "So11111111111111111111111111111111111111112",
  );
  if (wsolDelta <= 0n) {
    log.warn("Confirmed transaction did not credit agent wSOL ATA", {
      intentId,
      txHash,
      agentWsolAta,
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
    deps,
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
  deps: ConfirmIntentDeps = {},
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
    const meta = (intentData.metadata ?? {}) as Record<string, unknown> & IntentMetadata;
    if (meta.action === "near-bridge-out") {
      await verifyNearAndEnqueue(intentId, txHash, intentData, validateIntentFn, deps);
    } else {
      await verifySolanaAndEnqueue(intentId, txHash, intentData, validateIntentFn, deps);
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
