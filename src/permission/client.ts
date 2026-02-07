/**
 * Permission contract client for self-custodial operations
 *
 * This client wraps the NEAR permission contract, which in turn wraps
 * the ChainSignatureContract for MPC signing. Users register allowed
 * operations with signatures, and the TEE can only sign for operations
 * that are on the user's allowlist.
 */

import { JsonRpcProvider } from "@near-js/providers";
import { Account } from "@near-js/accounts";
import { KeyPairSigner } from "@near-js/signers";
import { parseSeedPhrase } from "near-seed-phrase";
import bs58 from "bs58";
import type { FinalExecutionOutcome } from "@near-js/types";
import { config, isTestnet } from "../config";
import { extractTxHash } from "../utils/near";
import { createLogger } from "../utils/logger";
import type {
  DerivationPath,
  WalletType,
  AllowedOperation,
  AllowedOperationInput,
  UserPermissionsView,
  GetActiveOperationsResult,
  RegisterWalletArgs,
  AddAllowedOperationArgs,
  RemoveAllowedOperationArgs,
  SignAllowedArgs,
} from "./types";

// ─── Configuration ──────────────────────────────────────────────────────────────

const networkId = isTestnet ? "testnet" : "mainnet";
const nodeUrl = config.nearRpcUrls[0] ||
  (isTestnet ? "https://rpc.testnet.near.org" : "https://rpc.mainnet.near.org");

// Permission contract ID - needs to be configured
const PERMISSION_CONTRACT_ID = process.env.PERMISSION_CONTRACT_ID ||
  (isTestnet ? "permission.shade.testnet" : "permission.shade.near");

const log = createLogger("permissionClient");

// Gas constants
const GAS_FOR_REGISTER = BigInt("50000000000000"); // 50 TGas
const GAS_FOR_ADD_OPERATION = BigInt("50000000000000"); // 50 TGas
const GAS_FOR_REMOVE_OPERATION = BigInt("30000000000000"); // 30 TGas
const GAS_FOR_SIGN_ALLOWED = BigInt("300000000000000"); // 300 TGas (cross-contract to MPC)

// ─── Provider Setup ─────────────────────────────────────────────────────────────

const nearProvider = new JsonRpcProvider({ url: nodeUrl });

// Cache for relayer account
let cachedRelayer: Account | null = null;

/**
 * Get the TEE relayer account that calls the permission contract
 */
async function getRelayerAccount(): Promise<Account> {
  if (cachedRelayer) {
    return cachedRelayer;
  }

  if (!config.nearSeedPhrase) {
    throw new Error("NEAR_SEED_PHRASE not configured");
  }

  const { secretKey, publicKey } = parseSeedPhrase(config.nearSeedPhrase);
  const pubKeyBase58 = publicKey.replace("ed25519:", "");
  const pubKeyBytes = bs58.decode(pubKeyBase58);
  const accountId = Buffer.from(pubKeyBytes).toString("hex");

  const signer = KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`);
  cachedRelayer = new Account(accountId, nearProvider, signer);

  return cachedRelayer;
}

// ─── View Methods ───────────────────────────────────────────────────────────────

/**
 * Get user permissions for a derivation path
 */
export async function getPermissions(
  derivationPath: DerivationPath,
): Promise<UserPermissionsView | null> {
  try {
    const result = await nearProvider.query({
      request_type: "call_function",
      finality: "final",
      account_id: PERMISSION_CONTRACT_ID,
      method_name: "get_permissions",
      args_base64: Buffer.from(JSON.stringify({ derivation_path: derivationPath })).toString("base64"),
    });

    const resultBytes = (result as unknown as { result: number[] }).result;
    if (!resultBytes || resultBytes.length === 0) {
      return null;
    }

    const resultStr = Buffer.from(resultBytes).toString("utf8");
    return JSON.parse(resultStr) as UserPermissionsView;
  } catch (err: any) {
    if (err.message?.includes("No permissions for derivation path")) {
      return null;
    }
    throw err;
  }
}

/**
 * Get a specific operation
 */
export async function getOperation(
  derivationPath: DerivationPath,
  operationId: string,
): Promise<AllowedOperation | null> {
  try {
    const result = await nearProvider.query({
      request_type: "call_function",
      finality: "final",
      account_id: PERMISSION_CONTRACT_ID,
      method_name: "get_operation",
      args_base64: Buffer.from(JSON.stringify({
        derivation_path: derivationPath,
        operation_id: operationId,
      })).toString("base64"),
    });

    const resultBytes = (result as unknown as { result: number[] }).result;
    if (!resultBytes || resultBytes.length === 0) {
      return null;
    }

    const resultStr = Buffer.from(resultBytes).toString("utf8");
    return JSON.parse(resultStr) as AllowedOperation;
  } catch (err: any) {
    if (err.message?.includes("Operation not found")) {
      return null;
    }
    throw err;
  }
}

/**
 * Get all active operations (for TEE polling)
 */
export async function getActiveOperations(
  fromIndex = 0,
  limit = 100,
): Promise<GetActiveOperationsResult[]> {
  const result = await nearProvider.query({
    request_type: "call_function",
    finality: "final",
    account_id: PERMISSION_CONTRACT_ID,
    method_name: "get_active_operations",
    args_base64: Buffer.from(JSON.stringify({
      from_index: fromIndex,
      limit,
    })).toString("base64"),
  });

  const resultBytes = (result as any).result;
  if (!resultBytes || resultBytes.length === 0) {
    return [];
  }

  const resultStr = Buffer.from(resultBytes).toString("utf8");
  return JSON.parse(resultStr) as GetActiveOperationsResult[];
}

/**
 * Check if an operation is allowed
 */
export async function isOperationAllowed(
  derivationPath: DerivationPath,
  operationId: string,
): Promise<boolean> {
  try {
    const result = await nearProvider.query({
      request_type: "call_function",
      finality: "final",
      account_id: PERMISSION_CONTRACT_ID,
      method_name: "is_operation_allowed",
      args_base64: Buffer.from(JSON.stringify({
        derivation_path: derivationPath,
        operation_id: operationId,
      })).toString("base64"),
    });

    const resultBytes = (result as unknown as { result: number[] }).result;
    if (!resultBytes || resultBytes.length === 0) {
      return false;
    }

    const resultStr = Buffer.from(resultBytes).toString("utf8");
    return JSON.parse(resultStr) as boolean;
  } catch (err) {
    log.debug("isOperationAllowed check failed", { derivationPath, operationId, err: String(err) });
    return false;
  }
}

/**
 * Get derivation path for a wallet address
 */
export async function getDerivationPathForWallet(
  chainAddress: string,
): Promise<DerivationPath | null> {
  try {
    const result = await nearProvider.query({
      request_type: "call_function",
      finality: "final",
      account_id: PERMISSION_CONTRACT_ID,
      method_name: "get_derivation_path_for_wallet",
      args_base64: Buffer.from(JSON.stringify({ chain_address: chainAddress })).toString("base64"),
    });

    const resultBytes = (result as unknown as { result: number[] }).result;
    if (!resultBytes || resultBytes.length === 0) {
      return null;
    }

    const resultStr = Buffer.from(resultBytes).toString("utf8");
    return JSON.parse(resultStr) as DerivationPath;
  } catch (err) {
    log.debug("getDerivationPathForWallet failed", { chainAddress, err: String(err) });
    return null;
  }
}

// ─── Change Methods (TEE Relayer) ───────────────────────────────────────────────

/**
 * Register a wallet for a derivation path
 * Called by TEE with user's signature
 */
export async function registerWallet(
  args: RegisterWalletArgs,
): Promise<string> {
  const relayer = await getRelayerAccount();

  const result = await relayer.functionCall({
    contractId: PERMISSION_CONTRACT_ID,
    methodName: "register_wallet",
    args,
    gas: GAS_FOR_REGISTER,
    attachedDeposit: BigInt(0),
  });

  const txHash = extractTxHash(result as FinalExecutionOutcome);

  log.info(`Wallet registered: ${txHash}`);
  return txHash;
}

/**
 * Add an allowed operation
 * Called by TEE with user's signature
 */
export async function addAllowedOperation(
  args: AddAllowedOperationArgs,
): Promise<{ txHash: string; operationId: string }> {
  const relayer = await getRelayerAccount();

  const result = await relayer.functionCall({
    contractId: PERMISSION_CONTRACT_ID,
    methodName: "add_allowed_operation",
    args,
    gas: GAS_FOR_ADD_OPERATION,
    attachedDeposit: BigInt(0),
  });

  const txHash = extractTxHash(result as FinalExecutionOutcome);

  // Extract operation_id from return value
  const returnValue = (result as any).status?.SuccessValue;
  let operationId = "";
  if (returnValue) {
    try {
      operationId = JSON.parse(Buffer.from(returnValue, "base64").toString("utf8"));
    } catch {
      // If we can't parse, generate one
      operationId = `op-${Date.now()}`;
    }
  }

  log.info(`Operation added: ${operationId} (${txHash})`);
  return { txHash, operationId };
}

/**
 * Remove an allowed operation
 * Called by TEE with user's signature
 */
export async function removeAllowedOperation(
  args: RemoveAllowedOperationArgs,
): Promise<string> {
  const relayer = await getRelayerAccount();

  const result = await relayer.functionCall({
    contractId: PERMISSION_CONTRACT_ID,
    methodName: "remove_allowed_operation",
    args,
    gas: GAS_FOR_REMOVE_OPERATION,
    attachedDeposit: BigInt(0),
  });

  const txHash = extractTxHash(result as FinalExecutionOutcome);

  log.info(`Operation removed: ${args.operation_id} (${txHash})`);
  return txHash;
}

/**
 * Request signature for an allowed operation
 * This is the key method - validates allowlist then calls MPC
 */
export async function signAllowed(
  args: SignAllowedArgs,
): Promise<Uint8Array> {
  const relayer = await getRelayerAccount();

  log.info(`Requesting signature for operation ${args.operation_id}`);
  log.debug(`Derivation path: ${args.derivation_path}`);
  log.debug(`Payload length: ${args.payload.length}`);

  const result = await relayer.functionCall({
    contractId: PERMISSION_CONTRACT_ID,
    methodName: "sign_allowed",
    args,
    gas: GAS_FOR_SIGN_ALLOWED,
    attachedDeposit: BigInt(0),
  });

  // Extract signature from callback result
  const returnValue = (result as any).status?.SuccessValue;
  if (!returnValue) {
    throw new Error("No signature returned from permission contract");
  }

  const signatureData = JSON.parse(Buffer.from(returnValue, "base64").toString("utf8"));

  // Parse signature based on format
  let signature: Uint8Array;
  if (typeof signatureData === "string") {
    // Hex string
    signature = signatureData.startsWith("0x")
      ? Buffer.from(signatureData.slice(2), "hex")
      : Buffer.from(signatureData, "hex");
  } else if (Array.isArray(signatureData)) {
    // Byte array
    signature = new Uint8Array(signatureData);
  } else if (signatureData.r && signatureData.s) {
    // r,s format (EdDSA)
    signature = new Uint8Array(64);
    signature.set(Buffer.from(signatureData.r, "hex"), 0);
    signature.set(Buffer.from(signatureData.s, "hex"), 32);
  } else {
    throw new Error(`Unknown signature format: ${JSON.stringify(signatureData)}`);
  }

  log.info(`Signature received, length: ${signature.length}`);
  return signature;
}

// ─── Helper Functions ───────────────────────────────────────────────────────────

/**
 * Create operation input for a limit order
 */
export function createLimitOrderOperation(params: {
  priceAsset: string;
  quoteAsset: string;
  triggerPrice: string;
  condition: "Above" | "Below";
  sourceAsset: string;
  targetAsset: string;
  maxAmount: string;
  destinationAddress: string;
  destinationChain: string;
  slippageBps: number;
  expiresAt?: number;
}): AllowedOperationInput {
  return {
    operation_type: {
      type: "LimitOrder",
      price_asset: params.priceAsset,
      quote_asset: params.quoteAsset,
      trigger_price: params.triggerPrice,
      condition: params.condition,
      source_asset: params.sourceAsset,
      target_asset: params.targetAsset,
      max_amount: params.maxAmount,
    },
    destination_address: params.destinationAddress,
    destination_chain: params.destinationChain,
    slippage_bps: params.slippageBps,
    expires_at: params.expiresAt,
  };
}

/**
 * Create operation input for a stop-loss
 */
export function createStopLossOperation(params: {
  priceAsset: string;
  quoteAsset: string;
  triggerPrice: string;
  sourceAsset: string;
  targetAsset: string;
  maxAmount: string;
  destinationAddress: string;
  destinationChain: string;
  slippageBps: number;
  expiresAt?: number;
}): AllowedOperationInput {
  return {
    operation_type: {
      type: "StopLoss",
      price_asset: params.priceAsset,
      quote_asset: params.quoteAsset,
      trigger_price: params.triggerPrice,
      source_asset: params.sourceAsset,
      target_asset: params.targetAsset,
      max_amount: params.maxAmount,
    },
    destination_address: params.destinationAddress,
    destination_chain: params.destinationChain,
    slippage_bps: params.slippageBps,
    expires_at: params.expiresAt,
  };
}

/**
 * Create operation input for a take-profit
 */
export function createTakeProfitOperation(params: {
  priceAsset: string;
  quoteAsset: string;
  triggerPrice: string;
  sourceAsset: string;
  targetAsset: string;
  maxAmount: string;
  destinationAddress: string;
  destinationChain: string;
  slippageBps: number;
  expiresAt?: number;
}): AllowedOperationInput {
  return {
    operation_type: {
      type: "TakeProfit",
      price_asset: params.priceAsset,
      quote_asset: params.quoteAsset,
      trigger_price: params.triggerPrice,
      source_asset: params.sourceAsset,
      target_asset: params.targetAsset,
      max_amount: params.maxAmount,
    },
    destination_address: params.destinationAddress,
    destination_chain: params.destinationChain,
    slippage_bps: params.slippageBps,
    expires_at: params.expiresAt,
  };
}

/**
 * Create operation input for a simple swap
 */
export function createSwapOperation(params: {
  sourceAsset: string;
  targetAsset: string;
  maxAmount: string;
  destinationAddress: string;
  destinationChain: string;
  slippageBps: number;
  expiresAt?: number;
}): AllowedOperationInput {
  return {
    operation_type: {
      type: "Swap",
      source_asset: params.sourceAsset,
      target_asset: params.targetAsset,
      max_amount: params.maxAmount,
    },
    destination_address: params.destinationAddress,
    destination_chain: params.destinationChain,
    slippage_bps: params.slippageBps,
    expires_at: params.expiresAt,
  };
}

/**
 * Convert wallet type string to enum value
 */
export function parseWalletType(chain: string): WalletType {
  const lower = chain.toLowerCase();
  if (lower === "near") return "Near";
  if (lower === "solana" || lower === "sol") return "Solana";
  if (lower === "evm" || lower === "ethereum" || lower === "eth" || lower === "base" || lower === "arbitrum") return "Evm";
  throw new Error(`Unknown chain type: ${chain}`);
}

/**
 * Get the permission contract ID
 */
export function getPermissionContractId(): string {
  return PERMISSION_CONTRACT_ID;
}
