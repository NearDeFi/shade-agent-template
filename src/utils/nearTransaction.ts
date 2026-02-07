import { config, isTestnet } from "../config";
import { fetchWithRetry } from "./http";
import { nearViewCall } from "./nearRpc";

const DEFAULT_NEAR_RPC = isTestnet
  ? "https://rpc.testnet.near.org"
  : "https://rpc.mainnet.near.org";

function getNearRpcUrl(): string {
  return config.nearRpcUrls[0] || DEFAULT_NEAR_RPC;
}

interface AccessKeyInfo {
  nonce: number;
  block_hash: string;
}

interface NearRpcResponse<T> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export async function getAccessKeyInfo(
  accountId: string,
  publicKey: string,
): Promise<AccessKeyInfo> {
  const rpcUrl = getNearRpcUrl();

  const response = await fetchWithRetry(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "dontcare",
        method: "query",
        params: {
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey,
        },
      }),
    },
    3,
    500,
  );

  const data = (await response.json()) as NearRpcResponse<{
    nonce: number;
    block_hash: string;
  }>;

  if (data.error) {
    throw new Error(`NEAR RPC error: ${data.error.message}`);
  }
  if (!data.result) {
    throw new Error("NEAR RPC returned no result");
  }

  return {
    nonce: data.result.nonce,
    block_hash: data.result.block_hash,
  };
}

export async function broadcastTransaction(
  signedTxBase64: string,
): Promise<{ txHash: string }> {
  const rpcUrl = getNearRpcUrl();

  const response = await fetchWithRetry(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "dontcare",
        method: "broadcast_tx_commit",
        params: [signedTxBase64],
      }),
    },
    3,
    500,
    30000, // 30 second timeout for tx broadcast
  );

  const data = (await response.json()) as NearRpcResponse<{
    transaction: { hash: string };
    status: unknown;
  }>;

  if (data.error) {
    throw new Error(`NEAR broadcast error: ${data.error.message}`);
  }
  if (!data.result) {
    throw new Error("NEAR broadcast returned no result");
  }

  return { txHash: data.result.transaction.hash };
}

// NEAR action types
export type NearAction =
  | { type: "FunctionCall"; methodName: string; args: string; gas: string; deposit: string }
  | { type: "Transfer"; deposit: string };

// Serialize a NEAR transaction for signing
// This creates the transaction bytes that need to be signed
export function serializeTransaction(params: {
  signerId: string;
  publicKey: string;
  nonce: number;
  receiverId: string;
  blockHash: string;
  actions: NearAction[];
}): Uint8Array {
  const { signerId, publicKey, nonce, receiverId, blockHash, actions } = params;

  // Simple borsh-like serialization for NEAR transactions
  const encoder = new TransactionEncoder();

  // Signer ID
  encoder.writeString(signerId);

  // Public key (ed25519 prefix + 32 bytes key)
  encoder.writePublicKey(publicKey);

  // Nonce (u64)
  encoder.writeU64(nonce);

  // Receiver ID
  encoder.writeString(receiverId);

  // Block hash (32 bytes)
  encoder.writeBlockHash(blockHash);

  // Actions
  encoder.writeU32(actions.length);
  for (const action of actions) {
    encoder.writeAction(action);
  }

  return encoder.toBytes();
}

// Simple encoder for NEAR transaction serialization
class TransactionEncoder {
  private buffer: number[] = [];

  writeU8(value: number) {
    this.buffer.push(value & 0xff);
  }

  writeU32(value: number) {
    this.buffer.push(value & 0xff);
    this.buffer.push((value >> 8) & 0xff);
    this.buffer.push((value >> 16) & 0xff);
    this.buffer.push((value >> 24) & 0xff);
  }

  writeU64(value: number | bigint) {
    // Write full 64-bit little-endian value using BigInt to avoid truncation
    const big = BigInt(value);
    for (let i = 0; i < 8; i++) {
      this.buffer.push(Number((big >> BigInt(i * 8)) & 0xffn));
    }
  }

  writeU128(value: string) {
    // Parse string as BigInt and write 16 bytes little endian
    const bigValue = BigInt(value);
    for (let i = 0; i < 16; i++) {
      this.buffer.push(Number((bigValue >> BigInt(i * 8)) & BigInt(0xff)));
    }
  }

  writeBytes(bytes: Uint8Array) {
    for (const byte of bytes) {
      this.buffer.push(byte);
    }
  }

  writeString(str: string) {
    const bytes = new TextEncoder().encode(str);
    this.writeU32(bytes.length);
    this.writeBytes(bytes);
  }

  writePublicKey(publicKey: string) {
    // Format: "ed25519:BASE58_KEY"
    if (!publicKey.startsWith("ed25519:")) {
      throw new Error("Only ed25519 public keys are supported");
    }

    const keyBase58 = publicKey.slice(8); // Remove "ed25519:" prefix
    const keyBytes = base58Decode(keyBase58);

    // Key type: 0 = ed25519
    this.writeU8(0);
    this.writeBytes(keyBytes);
  }

  writeBlockHash(blockHash: string) {
    const hashBytes = base58Decode(blockHash);
    if (hashBytes.length !== 32) {
      throw new Error("Block hash must be 32 bytes");
    }
    this.writeBytes(hashBytes);
  }

  writeAction(action: NearAction) {
    switch (action.type) {
      case "Transfer":
        this.writeU8(3); // Action type: Transfer
        this.writeU128(action.deposit);
        break;
      case "FunctionCall":
        this.writeU8(2); // Action type: FunctionCall
        this.writeString(action.methodName);
        // Args as bytes
        const argsBytes = new TextEncoder().encode(action.args);
        this.writeU32(argsBytes.length);
        this.writeBytes(argsBytes);
        // Gas (u64)
        const gas = BigInt(action.gas);
        for (let i = 0; i < 8; i++) {
          this.buffer.push(Number((gas >> BigInt(i * 8)) & BigInt(0xff)));
        }
        // Deposit (u128)
        this.writeU128(action.deposit);
        break;
      default:
        throw new Error(`Unsupported action type`);
    }
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}

// Base58 decode
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

  // Convert to bytes
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value = value >> 8n;
  }

  // Handle leading zeros (1s in base58)
  for (const char of str) {
    if (char !== "1") break;
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let value = BigInt(0);
  for (const byte of bytes) {
    value = value * BigInt(256) + BigInt(byte);
  }

  let result = "";
  while (value > 0n) {
    result = BASE58_ALPHABET[Number(value % 58n)] + result;
    value = value / 58n;
  }

  // Handle leading zeros
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = "1" + result;
  }

  return result || "1";
}

// Create a signed transaction from serialized bytes and signature
export function createSignedTransaction(
  serializedTx: Uint8Array,
  signature: Uint8Array,
): string {
  // Signed transaction = serialized transaction + signature (64 bytes for ed25519)
  const signedTx = new Uint8Array(serializedTx.length + 1 + signature.length);
  signedTx.set(serializedTx, 0);
  signedTx[serializedTx.length] = 0; // Signature type: 0 = ed25519
  signedTx.set(signature, serializedTx.length + 1);

  return Buffer.from(signedTx).toString("base64");
}
