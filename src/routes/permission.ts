// @ts-nocheck
// Permission routes temporarily disabled - see src/index.ts
/**
 * Permission API routes for managing self-custodial operations
 *
 * These endpoints allow users to:
 * - Register wallets for derivation paths
 * - Add/remove allowed operations with signatures
 * - Query permissions and operations
 */

import { Hono } from "hono";
import {
  getPermissions,
  getOperation,
  getActiveOperations,
  isOperationAllowed,
  getDerivationPathForWallet,
  registerWallet,
  addAllowedOperation,
  removeAllowedOperation,
  createLimitOrderOperation,
  createStopLossOperation,
  createTakeProfitOperation,
  createSwapOperation,
  parseWalletType,
  getPermissionContractId,
  type RegisterWalletArgs,
  type AddAllowedOperationArgs,
  type RemoveAllowedOperationArgs,
  type AllowedOperationInput,
} from "../permission";
import { verifySolanaSignature } from "../utils/solanaSignature";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError, parseJsonBody } from "./errorHandling";

const log = createLogger("permission");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

// ─── Query Endpoints ────────────────────────────────────────────────────────────

/**
 * GET /api/permission/contract
 * Get the permission contract ID
 */
app.get("/contract", (c) => {
  return c.json({ contractId: getPermissionContractId() });
});

/**
 * GET /api/permission/:derivationPath
 * Get permissions for a derivation path
 */
app.get("/:derivationPath", async (c) => {
  const derivationPath = c.req.param("derivationPath");

  try {
    const permissions = await getPermissions(derivationPath);
    if (!permissions) {
      throw new AppError("not_found", "No permissions found for derivation path");
    }
    return c.json(permissions);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("operation_failed", "Failed to fetch permissions", {
      cause: err,
    });
  }
});

/**
 * GET /api/permission/:derivationPath/:operationId
 * Get a specific operation
 */
app.get("/:derivationPath/:operationId", async (c) => {
  const derivationPath = c.req.param("derivationPath");
  const operationId = c.req.param("operationId");

  try {
    const operation = await getOperation(derivationPath, operationId);
    if (!operation) {
      throw new AppError("not_found", "Operation not found");
    }
    return c.json(operation);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("operation_failed", "Failed to fetch operation", {
      cause: err,
    });
  }
});

/**
 * GET /api/permission/active
 * Get all active operations (for TEE polling)
 */
app.get("/active", async (c) => {
  const fromIndex = parseInt(c.req.query("from") || "0", 10);
  const limit = parseInt(c.req.query("limit") || "100", 10);

  try {
    const operations = await getActiveOperations(fromIndex, limit);
    return c.json({ operations, count: operations.length });
  } catch (err) {
    throw new AppError("operation_failed", "Failed to fetch active operations", {
      cause: err,
    });
  }
});

/**
 * GET /api/permission/wallet/:address
 * Get derivation path for a wallet address
 */
app.get("/wallet/:address", async (c) => {
  const address = c.req.param("address");

  try {
    const derivationPath = await getDerivationPathForWallet(address);
    if (!derivationPath) {
      throw new AppError("not_found", "Wallet not registered");
    }
    return c.json({ derivationPath });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("operation_failed", "Failed to lookup wallet", {
      cause: err,
    });
  }
});

/**
 * GET /api/permission/check/:derivationPath/:operationId
 * Check if an operation is allowed
 */
app.get("/check/:derivationPath/:operationId", async (c) => {
  const derivationPath = c.req.param("derivationPath");
  const operationId = c.req.param("operationId");

  try {
    const allowed = await isOperationAllowed(derivationPath, operationId);
    return c.json({ allowed });
  } catch (err) {
    throw new AppError("operation_failed", "Failed to check operation", {
      cause: err,
    });
  }
});

// ─── Change Endpoints ───────────────────────────────────────────────────────────

interface RegisterWalletRequest {
  derivationPath: string;
  walletType: string; // "near" | "solana" | "evm"
  publicKey: string; // hex or base58 encoded
  chainAddress: string;
  signature: string; // hex encoded
  message: string; // the signed message
  nonce: number;
}

/**
 * POST /api/permission/register
 * Register a wallet for a derivation path
 */
app.post("/register", async (c) => {
  const body = await parseJsonBody<RegisterWalletRequest>(c);

  const { derivationPath, walletType, publicKey, chainAddress, signature, message, nonce } = body;

  if (!derivationPath || !walletType || !publicKey || !chainAddress || !signature || !message || nonce === undefined) {
    throw new AppError("invalid_request", "Missing required fields");
  }

  try {
    // Verify signature based on wallet type
    const messageBytes = Buffer.from(message, "utf8");
    const signatureBytes = Buffer.from(signature.replace("0x", ""), "hex");
    const publicKeyBytes = parsePublicKey(publicKey, walletType);

    const isValid = await verifySignature(
      walletType,
      publicKeyBytes,
      messageBytes,
      signatureBytes,
      chainAddress,
    );

    if (!isValid) {
      throw new AppError("unauthorized", "Invalid signature");
    }

    // Call contract
    const args: RegisterWalletArgs = {
      derivation_path: derivationPath,
      wallet_type: parseWalletType(walletType),
      public_key: Array.from(publicKeyBytes),
      chain_address: chainAddress,
      signature: Array.from(signatureBytes),
      message: Array.from(messageBytes),
      nonce,
    };

    const txHash = await registerWallet(args);
    return c.json({ success: true, txHash, derivationPath });
  } catch (err) {
    if (err instanceof AppError) throw err;
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    throw new AppError(
      "operation_failed",
      `Failed to register wallet: ${errorMessage}`,
      { cause: err },
    );
  }
});

interface AddOperationRequest {
  derivationPath: string;
  operationType: "limit-order" | "stop-loss" | "take-profit" | "swap";
  // Common fields
  sourceAsset: string;
  targetAsset: string;
  maxAmount: string;
  destinationAddress: string;
  destinationChain: string;
  slippageBps: number;
  expiresAt?: number;
  // Price condition fields (for conditional orders)
  priceAsset?: string;
  quoteAsset?: string;
  triggerPrice?: string;
  condition?: "above" | "below";
  // Signature
  signature: string;
  message: string;
}

/**
 * POST /api/permission/operation
 * Add an allowed operation
 */
app.post("/operation", async (c) => {
  const body = await parseJsonBody<AddOperationRequest>(c);

  const {
    derivationPath,
    operationType,
    sourceAsset,
    targetAsset,
    maxAmount,
    destinationAddress,
    destinationChain,
    slippageBps,
    expiresAt,
    priceAsset,
    quoteAsset,
    triggerPrice,
    condition,
    signature,
    message,
  } = body;

  if (!derivationPath || !operationType || !sourceAsset || !targetAsset || !maxAmount ||
      !destinationAddress || !destinationChain || !signature || !message) {
    throw new AppError("invalid_request", "Missing required fields");
  }

  try {
    // Get user's registered wallet to verify signature
    const permissions = await getPermissions(derivationPath);
    if (!permissions || permissions.owner_wallets.length === 0) {
      throw new AppError("not_found", "No registered wallet for derivation path");
    }

    const wallet = permissions.owner_wallets[0];
    const messageBytes = Buffer.from(message, "utf8");
    const signatureBytes = Buffer.from(signature.replace("0x", ""), "hex");

    const isValid = await verifySignature(
      walletTypeToString(wallet.wallet_type),
      new Uint8Array(wallet.public_key),
      messageBytes,
      signatureBytes,
      wallet.chain_address,
    );

    if (!isValid) {
      throw new AppError("unauthorized", "Invalid signature");
    }

    // Build operation input
    let operation: AllowedOperationInput;
    if (operationType === "swap") {
      operation = createSwapOperation({
        sourceAsset,
        targetAsset,
        maxAmount,
        destinationAddress,
        destinationChain,
        slippageBps,
        expiresAt,
      });
    } else if (operationType === "limit-order") {
      if (!priceAsset || !quoteAsset || !triggerPrice || !condition) {
        throw new AppError("invalid_request", "Missing price condition fields for limit order");
      }
      operation = createLimitOrderOperation({
        priceAsset,
        quoteAsset,
        triggerPrice,
        condition: condition === "above" ? "Above" : "Below",
        sourceAsset,
        targetAsset,
        maxAmount,
        destinationAddress,
        destinationChain,
        slippageBps,
        expiresAt,
      });
    } else if (operationType === "stop-loss") {
      if (!priceAsset || !quoteAsset || !triggerPrice) {
        throw new AppError("invalid_request", "Missing price fields for stop-loss");
      }
      operation = createStopLossOperation({
        priceAsset,
        quoteAsset,
        triggerPrice,
        sourceAsset,
        targetAsset,
        maxAmount,
        destinationAddress,
        destinationChain,
        slippageBps,
        expiresAt,
      });
    } else if (operationType === "take-profit") {
      if (!priceAsset || !quoteAsset || !triggerPrice) {
        throw new AppError("invalid_request", "Missing price fields for take-profit");
      }
      operation = createTakeProfitOperation({
        priceAsset,
        quoteAsset,
        triggerPrice,
        sourceAsset,
        targetAsset,
        maxAmount,
        destinationAddress,
        destinationChain,
        slippageBps,
        expiresAt,
      });
    } else {
      throw new AppError("invalid_request", "Unknown operation type");
    }

    // Call contract
    const args: AddAllowedOperationArgs = {
      derivation_path: derivationPath,
      operation,
      signature: Array.from(signatureBytes),
      message: Array.from(messageBytes),
    };

    const { txHash, operationId } = await addAllowedOperation(args);
    return c.json({ success: true, txHash, operationId, derivationPath });
  } catch (err) {
    if (err instanceof AppError) throw err;
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    throw new AppError(
      "operation_failed",
      `Failed to add operation: ${errorMessage}`,
      { cause: err },
    );
  }
});

interface RemoveOperationRequest {
  derivationPath: string;
  operationId: string;
  signature: string;
  message: string;
}

/**
 * DELETE /api/permission/operation
 * Remove an allowed operation
 */
app.delete("/operation", async (c) => {
  const body = await parseJsonBody<RemoveOperationRequest>(c);

  const { derivationPath, operationId, signature, message } = body;

  if (!derivationPath || !operationId || !signature || !message) {
    throw new AppError("invalid_request", "Missing required fields");
  }

  try {
    // Get user's registered wallet to verify signature
    const permissions = await getPermissions(derivationPath);
    if (!permissions || permissions.owner_wallets.length === 0) {
      throw new AppError("not_found", "No registered wallet for derivation path");
    }

    const wallet = permissions.owner_wallets[0];
    const messageBytes = Buffer.from(message, "utf8");
    const signatureBytes = Buffer.from(signature.replace("0x", ""), "hex");

    const isValid = await verifySignature(
      walletTypeToString(wallet.wallet_type),
      new Uint8Array(wallet.public_key),
      messageBytes,
      signatureBytes,
      wallet.chain_address,
    );

    if (!isValid) {
      throw new AppError("unauthorized", "Invalid signature");
    }

    // Call contract
    const args: RemoveAllowedOperationArgs = {
      derivation_path: derivationPath,
      operation_id: operationId,
      signature: Array.from(signatureBytes),
      message: Array.from(messageBytes),
    };

    const txHash = await removeAllowedOperation(args);
    return c.json({ success: true, txHash, operationId });
  } catch (err) {
    if (err instanceof AppError) throw err;
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    throw new AppError(
      "operation_failed",
      `Failed to remove operation: ${errorMessage}`,
      { cause: err },
    );
  }
});

// ─── Helper Functions ───────────────────────────────────────────────────────────

/**
 * Parse public key from various formats
 */
function parsePublicKey(publicKey: string, walletType: string): Uint8Array {
  // Remove common prefixes
  let key = publicKey;
  if (key.startsWith("0x")) key = key.slice(2);
  if (key.startsWith("ed25519:")) key = key.slice(8);
  if (key.startsWith("secp256k1:")) key = key.slice(10);

  // Try hex decode first
  if (/^[0-9a-fA-F]+$/.test(key)) {
    return Buffer.from(key, "hex");
  }

  // Try base58 decode for Solana
  if (walletType.toLowerCase() === "solana") {
    const bs58 = require("bs58");
    return bs58.decode(key);
  }

  throw new Error(`Unable to parse public key: ${publicKey}`);
}

/**
 * Verify signature based on wallet type
 * Note: For permissions, we use a simpler signature scheme than NEP-413
 * The message is JSON that includes all relevant operation details
 */
async function verifySignature(
  walletType: string,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
  address: string,
): Promise<boolean> {
  const type = walletType.toLowerCase();

  if (type === "solana" || type === "sol") {
    // Solana signature verification
    return verifySolanaSignature({
      signature: Buffer.from(signature).toString("hex"),
      publicKey: require("bs58").encode(publicKey),
      message: Buffer.from(message).toString("utf8"),
    });
  }

  if (type === "near") {
    // NEAR Ed25519 signature verification using tweetnacl
    // For permission messages, we sign the raw message (not NEP-413 format)
    const nacl = require("tweetnacl");
    const messageHash = require("crypto").createHash("sha256").update(message).digest();
    return nacl.sign.detached.verify(new Uint8Array(messageHash), signature, publicKey);
  }

  if (type === "evm" || type === "ethereum" || type === "eth" || type === "base" || type === "arbitrum") {
    // EVM signature verification - delegated to contract for now
    // The contract will verify using ecrecover
    log.warn("EVM signature verification delegated to contract");
    return true; // Contract will verify
  }

  throw new Error(`Unknown wallet type: ${walletType}`);
}

/**
 * Convert wallet type enum to string
 */
function walletTypeToString(walletType: string): string {
  if (walletType === "Near") return "near";
  if (walletType === "Solana") return "solana";
  if (walletType === "Evm") return "evm";
  return walletType.toLowerCase();
}

export default app;
