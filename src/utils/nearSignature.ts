import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "crypto";
import { UserSignature, NearUserSignature, LegacyUserSignature } from "../queue/types";
import { createLogger } from "./logger";

const log = createLogger("nearSig");

/**
 * NEP-413 Payload structure for message signing
 * See: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
 */
interface NEP413Payload {
  message: string;
  nonce: Uint8Array; // 32 bytes
  recipient: string;
  callbackUrl?: string;
}

/**
 * NEP-413 tag prefix: 2^31 + 413 = 2147484061
 * This ensures the signed payload cannot be confused with a valid transaction
 */
const NEP413_TAG = 2147484061;

/**
 * Borsh-serializes a NEP-413 payload
 *
 * Borsh serialization format:
 * - u32: 4 bytes little-endian
 * - string: 4 bytes length (little-endian) + UTF-8 bytes
 * - [u8; 32]: 32 bytes directly
 * - Option<string>: 1 byte (0 = None, 1 = Some) + string if Some
 */
function serializeNEP413Payload(tag: number, payload: NEP413Payload): Uint8Array {
  const parts: Uint8Array[] = [];

  // Serialize tag as u32 (little-endian)
  const tagBytes = new Uint8Array(4);
  tagBytes[0] = tag & 0xff;
  tagBytes[1] = (tag >> 8) & 0xff;
  tagBytes[2] = (tag >> 16) & 0xff;
  tagBytes[3] = (tag >> 24) & 0xff;
  parts.push(tagBytes);

  // Serialize message as string (length prefix + UTF-8 bytes)
  const messageBytes = Buffer.from(payload.message, "utf-8");
  const messageLenBytes = new Uint8Array(4);
  messageLenBytes[0] = messageBytes.length & 0xff;
  messageLenBytes[1] = (messageBytes.length >> 8) & 0xff;
  messageLenBytes[2] = (messageBytes.length >> 16) & 0xff;
  messageLenBytes[3] = (messageBytes.length >> 24) & 0xff;
  parts.push(messageLenBytes);
  parts.push(new Uint8Array(messageBytes));

  // Serialize nonce as [u8; 32] (fixed size, no length prefix)
  if (payload.nonce.length !== 32) {
    throw new Error(`Nonce must be exactly 32 bytes, got ${payload.nonce.length}`);
  }
  parts.push(payload.nonce);

  // Serialize recipient as string
  const recipientBytes = Buffer.from(payload.recipient, "utf-8");
  const recipientLenBytes = new Uint8Array(4);
  recipientLenBytes[0] = recipientBytes.length & 0xff;
  recipientLenBytes[1] = (recipientBytes.length >> 8) & 0xff;
  recipientLenBytes[2] = (recipientBytes.length >> 16) & 0xff;
  recipientLenBytes[3] = (recipientBytes.length >> 24) & 0xff;
  parts.push(recipientLenBytes);
  parts.push(new Uint8Array(recipientBytes));

  // Serialize callbackUrl as Option<string>
  if (payload.callbackUrl !== undefined) {
    parts.push(new Uint8Array([1])); // Some
    const callbackBytes = Buffer.from(payload.callbackUrl, "utf-8");
    const callbackLenBytes = new Uint8Array(4);
    callbackLenBytes[0] = callbackBytes.length & 0xff;
    callbackLenBytes[1] = (callbackBytes.length >> 8) & 0xff;
    callbackLenBytes[2] = (callbackBytes.length >> 16) & 0xff;
    callbackLenBytes[3] = (callbackBytes.length >> 24) & 0xff;
    parts.push(callbackLenBytes);
    parts.push(new Uint8Array(callbackBytes));
  } else {
    parts.push(new Uint8Array([0])); // None
  }

  // Concatenate all parts
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

/**
 * Parses a NEAR public key string (e.g., "ed25519:ABC...") into raw bytes
 */
function parseNearPublicKey(publicKey: string): Uint8Array {
  const [keyType, keyData] = publicKey.split(":");

  if (keyType !== "ed25519") {
    throw new Error(`Unsupported key type: ${keyType}. Only ed25519 is supported.`);
  }

  if (!keyData) {
    throw new Error("Invalid public key format. Expected 'ed25519:<base58-key>'");
  }

  return bs58.decode(keyData);
}

/**
 * Decodes a signature from base64 or hex format
 */
function decodeSignature(signature: string): Uint8Array {
  // Try base64 first
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

  throw new Error("Invalid signature format. Expected base64 or hex-encoded 64-byte signature.");
}

/**
 * Type guard to check if a signature is a NEAR NEP-413 signature
 */
export function isNearSignature(sig: UserSignature): sig is NearUserSignature | LegacyUserSignature {
  return "nonce" in sig && "recipient" in sig;
}

/**
 * Verifies a NEP-413 signature
 *
 * NEP-413 signing process:
 * 1. Create a Payload struct with message, nonce, recipient, callbackUrl
 * 2. Borsh-serialize the payload
 * 3. Prepend the 4-byte Borsh representation of 2^31 + 413
 * 4. SHA-256 hash the combined bytes
 * 5. Sign the hash with Ed25519
 *
 * @param userSignature - The signature object containing message, signature, public key, nonce, and recipient
 * @returns true if the signature is valid, false otherwise
 */
export function verifyNearSignature(userSignature: UserSignature): boolean {
  try {
    // Check if this is a NEAR signature
    if (!isNearSignature(userSignature)) {
      log.error("Signature is not a NEAR NEP-413 signature (missing nonce/recipient)");
      return false;
    }

    // Decode the nonce from base64
    const nonceBytes = new Uint8Array(Buffer.from(userSignature.nonce, "base64"));
    if (nonceBytes.length !== 32) {
      log.error("Invalid nonce length", { expected: 32, got: nonceBytes.length });
      return false;
    }

    // Construct the NEP-413 payload
    const payload: NEP413Payload = {
      message: userSignature.message,
      nonce: nonceBytes,
      recipient: userSignature.recipient,
      // callbackUrl is undefined (not used in our flow)
    };

    // Serialize with NEP-413 tag prefix
    const serialized = serializeNEP413Payload(NEP413_TAG, payload);

    // SHA-256 hash the serialized payload (NEAR signs hashes, not raw messages)
    const hash = crypto.createHash("sha256").update(serialized).digest();

    // Decode public key and signature
    const publicKeyBytes = parseNearPublicKey(userSignature.publicKey);
    const signatureBytes = decodeSignature(userSignature.signature);

    // Verify the signature against the hash
    return nacl.sign.detached.verify(new Uint8Array(hash), signatureBytes, publicKeyBytes);
  } catch (error) {
    log.error("Signature verification failed", { err: String(error) });
    return false;
  }
}

/**
 * Verifies that the signature's public key matches the expected public key
 * @param userSignature - The signature object
 * @param expectedPublicKey - The expected NEAR public key
 * @returns true if keys match, false otherwise
 */
export function verifyPublicKeyMatch(
  userSignature: UserSignature,
  expectedPublicKey: string,
): boolean {
  // Normalize both keys for comparison
  const normalizeKey = (key: string) => {
    if (key.startsWith("ed25519:")) {
      return key;
    }
    return `ed25519:${key}`;
  };

  return normalizeKey(userSignature.publicKey) === normalizeKey(expectedPublicKey);
}

/**
 * Creates the canonical message to sign for an intent
 * This ensures the user is signing a specific intent and not a generic message
 */
export function createIntentSigningMessage(intent: {
  intentId: string;
  sourceAmount: string;
  destinationAmount?: string;
  finalAsset: string;
  userDestination: string;
  metadata?: { action?: string } & Record<string, unknown>;
}): string {
  // Create a deterministic message that includes all critical intent fields
  const message = JSON.stringify({
    intentId: intent.intentId,
    sourceAmount: intent.sourceAmount,
    destinationAmount: intent.destinationAmount,
    finalAsset: intent.finalAsset,
    userDestination: intent.userDestination,
    action: intent.metadata?.action,
  });

  // Return SHA-256 hash as hex string
  const hash = crypto.createHash("sha256").update(message).digest("hex");
  return hash;
}

/**
 * Validates a user signature for an intent
 * @param userSignature - The signature to validate
 * @param expectedPublicKey - The NEAR public key that should have signed
 * @param expectedMessage - The expected message hash (optional, for additional validation)
 * @returns An object with isValid and optional error message
 */
export function validateIntentSignature(
  userSignature: UserSignature,
  expectedPublicKey: string,
  expectedMessage?: string,
): { isValid: boolean; error?: string } {
  // Check if this is a NEAR signature
  if (!isNearSignature(userSignature)) {
    return {
      isValid: false,
      error: "Not a NEAR NEP-413 signature. Missing nonce or recipient.",
    };
  }

  // Check public key matches
  if (!verifyPublicKeyMatch(userSignature, expectedPublicKey)) {
    return {
      isValid: false,
      error: `Public key mismatch. Expected ${expectedPublicKey}, got ${userSignature.publicKey}`,
    };
  }

  // Check message matches if provided
  if (expectedMessage && userSignature.message !== expectedMessage) {
    return {
      isValid: false,
      error: "Message mismatch. The signed message does not match the intent.",
    };
  }

  // Verify cryptographic signature (NEP-413)
  if (!verifyNearSignature(userSignature)) {
    return {
      isValid: false,
      error: "Invalid signature. Cryptographic verification failed.",
    };
  }

  return { isValid: true };
}
