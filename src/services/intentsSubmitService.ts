import type { IntentValidator } from "../queue/validation";
import type { IntentMessage } from "../queue/types";
import { setStatus } from "../state/status";
import {
  createIntentSigningMessage,
  isNearSignature,
  validateIntentSignature,
} from "../utils/nearSignature";
import {
  createSolanaIntentSigningMessage,
  validateSolanaIntentSignature,
} from "../utils/solanaSignature";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { queueClient } from "../queue/client";
import { intentValidator as sharedIntentValidator } from "../queue/flowCatalog";

const log = createLogger("intents/submitService");

function requireVerificationProof(payload: IntentMessage) {
  const hasDepositProof = payload.originTxHash && payload.intentsDepositAddress;
  const hasSignatureProof = payload.userSignature;

  if (!hasDepositProof && !hasSignatureProof) {
    log.warn("Rejected intent without verification proof", {
      intentId: payload.intentId,
      hasOriginTxHash: !!payload.originTxHash,
      hasDepositAddress: !!payload.intentsDepositAddress,
      hasSignature: !!payload.userSignature,
    });
    throw new AppError(
      "forbidden",
      "Intent requires verification: either originTxHash + intentsDepositAddress (for deposits) or userSignature (for withdrawals)",
    );
  }
}

function verifyIntentSignature(payload: IntentMessage) {
  if (!payload.userSignature) {
    return;
  }

  let signatureType = "unknown";

  if (isNearSignature(payload.userSignature)) {
    signatureType = "near";

    if (!payload.nearPublicKey) {
      throw new AppError("invalid_request", "nearPublicKey is required for NEAR signatures");
    }

    const expectedMessage = createIntentSigningMessage(payload);
    const result = validateIntentSignature(
      payload.userSignature,
      payload.nearPublicKey,
      expectedMessage,
    );

    if (!result.isValid) {
      log.warn("Rejected intent with invalid NEAR signature", {
        intentId: payload.intentId,
        publicKey: payload.userSignature.publicKey,
        error: result.error,
      });
      throw new AppError("forbidden", "Invalid userSignature");
    }
  } else {
    signatureType = "solana";

    if (!payload.userDestination) {
      throw new AppError("invalid_request", "userDestination is required for Solana signatures");
    }

    const expectedMessage = createSolanaIntentSigningMessage(payload);
    const result = validateSolanaIntentSignature(
      {
        message: payload.userSignature.message,
        signature: payload.userSignature.signature,
        publicKey: payload.userSignature.publicKey,
      },
      payload.userDestination,
      expectedMessage,
    );

    if (!result.isValid) {
      log.warn("Rejected intent with invalid Solana signature", {
        intentId: payload.intentId,
        publicKey: payload.userSignature.publicKey,
        error: result.error,
      });
      throw new AppError("forbidden", "Invalid userSignature");
    }
  }

  log.info("Signature verified for intent", {
    intentId: payload.intentId,
    publicKey: payload.userSignature.publicKey,
    signatureType,
  });
}

function logDepositProof(payload: IntentMessage) {
  const hasDepositProof = payload.originTxHash && payload.intentsDepositAddress;
  if (!hasDepositProof) {
    return;
  }

  log.info("Deposit-verified intent received", {
    intentId: payload.intentId,
    originTxHash: payload.originTxHash,
    depositAddress: payload.intentsDepositAddress,
  });
}

export async function submitIntentForProcessing(
  payload: IntentMessage,
  validateIntentFn: IntentValidator = sharedIntentValidator,
) {
  requireVerificationProof(payload);
  verifyIntentSignature(payload);
  logDepositProof(payload);

  let validatedIntent;
  try {
    validatedIntent = validateIntentFn(payload);
  } catch (err) {
    throw new AppError("invalid_request", (err as Error).message, { cause: err });
  }

  try {
    await queueClient.enqueueIntent(validatedIntent);
    await setStatus(validatedIntent.intentId, { state: "pending" });
  } catch (err) {
    log.error("Failed to enqueue intent", { err: String(err) });
    throw new AppError("internal_error", "Failed to enqueue intent", { cause: err });
  }

  return {
    intentId: validatedIntent.intentId,
    state: "pending" as const,
  };
}
