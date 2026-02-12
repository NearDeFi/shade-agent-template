import { requestSignature } from "@neardefi/shade-agent-js";
import { utils } from "chainsig.js";
import { config } from "../config";
import { chainSignatureContract } from "../infra/chainSignature";
import { parseSignature } from "./signature";
import { SOLANA_DEFAULT_PATH } from "./solana";
import { createLogger } from "./logger";

const log = createLogger("chainSig");

const { uint8ArrayToHex } = utils.cryptography;

export const NEAR_DEFAULT_PATH = "near-1";

/**
 * Derives a NEAR implicit account address from the chain signature MPC.
 * The implicit account ID is the hex-encoded 32-byte ed25519 public key.
 *
 * @param path - Derivation path (default: "near-1")
 * @param nearPublicKey - Optional NEAR public key to include in derivation
 * @param userDestination - Optional user destination address for custody isolation
 * @returns The derived NEAR implicit account ID and public key in ed25519:... format
 */
export async function deriveNearImplicitAccount(
  path = NEAR_DEFAULT_PATH,
  nearPublicKey?: string,
  userDestination?: string,
): Promise<{ accountId: string; publicKey: string }> {
  const accountId = config.shadeContractId;
  if (!accountId) throw new Error("NEXT_PUBLIC_contractId not configured");

  // Build derivation path including user identifiers for custody isolation
  let derivationPath = path;
  if (nearPublicKey) {
    derivationPath = `${derivationPath},${nearPublicKey}`;
  }
  if (userDestination) {
    derivationPath = `${derivationPath},${userDestination}`;
  }

  // Derive the ed25519 public key from the MPC
  // IsEd25519: true is required to get an ed25519 key for NEAR implicit accounts
  const derivedKey = await chainSignatureContract.getDerivedPublicKey({
    path: derivationPath,
    predecessor: accountId,
    IsEd25519: true,
  });

  log.info("Derived key", { path: derivationPath, derivedKey: String(derivedKey) });

  // Parse the derived key - expecting ed25519 format (Ed25519:base58key)
  // The chainsig.js library returns "Ed25519:" prefix (capital E)
  if (typeof derivedKey !== "string" || (!derivedKey.startsWith("ed25519:") && !derivedKey.startsWith("Ed25519:"))) {
    throw new Error(`Expected ed25519 key, got: ${derivedKey}`);
  }

  // Decode the base58 public key to get raw bytes
  // Handle both "ed25519:" and "Ed25519:" prefixes
  const keyBase58 = derivedKey.slice(8); // Remove "ed25519:" or "Ed25519:" prefix
  const keyBytes = base58Decode(keyBase58);

  if (keyBytes.length !== 32) {
    throw new Error(`Expected 32-byte ed25519 key, got ${keyBytes.length} bytes`);
  }

  // NEAR implicit account ID is the hex-encoded 32-byte public key
  const implicitAccountId = Buffer.from(keyBytes).toString("hex");

  // Normalize to lowercase "ed25519:" for NEAR compatibility
  const normalizedPublicKey = `ed25519:${keyBase58}`;

  return {
    accountId: implicitAccountId,
    publicKey: normalizedPublicKey,
  };
}

// Base58 decode helper
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [];
  let value = BigInt(0);

  for (const char of str) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    value = value * BigInt(58) + BigInt(index);
  }

  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value = value >> 8n;
  }

  // Handle leading zeros (1s in base58)
  for (const char of str) {
    if (char !== "1") break;
    bytes.unshift(0);
  }

  // Pad to 32 bytes if needed
  while (bytes.length < 32) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

/**
 * Signs a payload using NEAR chain signatures (EdDSA for Solana).
 * @param payloadBytes - The serialized transaction message to sign
 * @param userDestination - Optional user destination address for custody isolation
 * @returns The signature as Uint8Array
 */
export async function signWithNearChainSignatures(
  payloadBytes: Uint8Array,
  userDestination?: string,
): Promise<Uint8Array> {
  if (!config.shadeContractId) {
    throw new Error("NEXT_PUBLIC_contractId not configured for signing");
  }

  // Build derivation path including user destination for custody isolation
  let derivationPath = SOLANA_DEFAULT_PATH;
  if (userDestination) {
    derivationPath = `${derivationPath},${userDestination}`;
  }

  const payload = uint8ArrayToHex(payloadBytes);
  log.info("Requesting signature", {
    path: derivationPath,
    payloadLength: payloadBytes.length,
    keyType: "Eddsa",
  });

  const signRes = await requestSignature({
    path: derivationPath,
    payload,
    keyType: "Eddsa",
  });

  log.info("Signature response", {
    hasSignature: !!signRes?.signature,
    responseKeys: signRes ? Object.keys(signRes) : [],
    response: JSON.stringify(signRes).slice(0, 500),
  });

  if (!signRes.signature) {
    throw new Error(`Signature missing from chain-signature response: ${JSON.stringify(signRes)}`);
  }

  const sig = parseSignature(signRes.signature);
  if (!sig) throw new Error("Unsupported signature encoding");
  return sig;
}

/**
 * Creates a dummy signer interface for Kamino SDK that only provides an address.
 * The actual signing is done via NEAR chain signatures.
 * @param ownerAddress - The Solana address string
 */
export function createDummySigner(ownerAddress: string) {
  return {
    address: ownerAddress,
    signTransactions: async () => {
      throw new Error("Signing handled by NEAR chain signatures");
    },
    signMessages: async () => {
      throw new Error("Signing handled by NEAR chain signatures");
    },
  } as any;
}
