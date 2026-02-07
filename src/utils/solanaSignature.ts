import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "crypto";
import { PublicKey } from "@solana/web3.js";
import { createLogger } from "./logger";

const log = createLogger("solanaSig");

/**
 * Solana signature structure for intent authorization
 */
export interface SolanaUserSignature {
  /** The signed message (typically a hash of the intent payload) */
  message: string;
  /** The signature in base58 or base64 format (64 bytes) */
  signature: string;
  /** The Solana public key that signed (base58 encoded) */
  publicKey: string;
}

/**
 * Decodes a Solana signature from base58 or base64 format
 */
function decodeSignature(signature: string): Uint8Array {
  // Try base58 first (Solana's native format)
  try {
    const decoded = bs58.decode(signature);
    if (decoded.length === 64) {
      return decoded;
    }
  } catch {
    // Fall through to base64
  }

  // Try base64
  if (/^[A-Za-z0-9+/=]+$/.test(signature) && signature.length % 4 === 0) {
    try {
      const decoded = Buffer.from(signature, "base64");
      if (decoded.length === 64) {
        return new Uint8Array(decoded);
      }
    } catch {
      // Fall through to hex
    }
  }

  // Try hex
  if (/^(0x)?[0-9a-fA-F]+$/.test(signature)) {
    const hexStr = signature.startsWith("0x") ? signature.slice(2) : signature;
    if (hexStr.length === 128) {
      return new Uint8Array(Buffer.from(hexStr, "hex"));
    }
  }

  throw new Error("Invalid signature format. Expected base58, base64, or hex-encoded 64-byte signature.");
}

/**
 * Verifies a Solana Ed25519 signature
 *
 * Solana wallets typically sign the raw message bytes (UTF-8 encoded).
 * The message is NOT hashed before signing (unlike NEAR/NEP-413).
 *
 * @param userSignature - The signature object containing message, signature, and public key
 * @returns true if the signature is valid, false otherwise
 */
export function verifySolanaSignature(userSignature: SolanaUserSignature): boolean {
  try {
    // Decode the message - it should be the UTF-8 bytes of the message string
    const messageBytes = new TextEncoder().encode(userSignature.message);

    // Decode public key from base58
    const publicKeyBytes = bs58.decode(userSignature.publicKey);
    if (publicKeyBytes.length !== 32) {
      log.error("Invalid public key length", { expected: 32, got: publicKeyBytes.length });
      return false;
    }

    // Decode signature
    const signatureBytes = decodeSignature(userSignature.signature);

    // Verify the Ed25519 signature
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch (error) {
    log.error("Solana signature verification failed", { err: String(error) });
    return false;
  }
}

/**
 * Verifies that the signature's public key matches the expected Solana address
 * @param userSignature - The signature object
 * @param expectedAddress - The expected Solana address (base58)
 * @returns true if addresses match, false otherwise
 */
export function verifySolanaAddressMatch(
  userSignature: SolanaUserSignature,
  expectedAddress: string,
): boolean {
  try {
    // Normalize both addresses
    const signatureAddress = new PublicKey(userSignature.publicKey).toBase58();
    const expected = new PublicKey(expectedAddress).toBase58();
    return signatureAddress === expected;
  } catch {
    return false;
  }
}

/**
 * Creates the canonical message to sign for an intent (Solana version)
 * This ensures the user is signing a specific intent and not a generic message
 */
export function createSolanaIntentSigningMessage(intent: {
  intentId: string;
  sourceAmount: string;
  destinationAmount?: string;
  finalAsset: string;
  userDestination: string;
  metadata?: { action?: string } & Record<string, unknown>;
}): string {
  // Create a deterministic message that includes all critical intent fields
  // This is the same format as NEAR for consistency
  const payload = JSON.stringify({
    intentId: intent.intentId,
    sourceAmount: intent.sourceAmount,
    destinationAmount: intent.destinationAmount,
    finalAsset: intent.finalAsset,
    userDestination: intent.userDestination,
    action: intent.metadata?.action,
  });

  // Return SHA-256 hash as hex string
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  return hash;
}

/**
 * Validates a Solana user signature for an intent
 * @param userSignature - The signature to validate
 * @param expectedAddress - The Solana address that should have signed
 * @param expectedMessage - The expected message hash (optional, for additional validation)
 * @returns An object with isValid and optional error message
 */
export function validateSolanaIntentSignature(
  userSignature: SolanaUserSignature,
  expectedAddress: string,
  expectedMessage?: string,
): { isValid: boolean; error?: string } {
  // Check public key/address matches
  if (!verifySolanaAddressMatch(userSignature, expectedAddress)) {
    return {
      isValid: false,
      error: `Address mismatch. Expected ${expectedAddress}, got ${userSignature.publicKey}`,
    };
  }

  // Check message matches if provided
  if (expectedMessage && userSignature.message !== expectedMessage) {
    return {
      isValid: false,
      error: "Message mismatch. The signed message does not match the intent.",
    };
  }

  // Verify cryptographic signature
  if (!verifySolanaSignature(userSignature)) {
    return {
      isValid: false,
      error: "Invalid signature. Cryptographic verification failed.",
    };
  }

  return { isValid: true };
}
