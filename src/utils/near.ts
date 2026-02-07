import { chainAdapters, utils } from "chainsig.js";
import { JsonRpcProvider } from "@near-js/providers";
import { Account } from "@near-js/accounts";
import { KeyPairSigner } from "@near-js/signers";
import { NEAR } from "@near-js/tokens";
import {
  Transaction as NearTransaction,
  SignedTransaction as NearSignedTransaction,
  createTransaction as nearCreateTransaction,
  encodeTransaction as nearEncodeTransaction,
  Action,
  Signature as NearSignature,
  actionCreators,
} from "@near-js/transactions";
import { PublicKey, KeyType } from "@near-js/crypto";
import { baseDecode } from "@near-js/utils";
import { parseSeedPhrase } from "near-seed-phrase";
import bs58 from "bs58";
import crypto from "crypto";
import type { FinalExecutionOutcome } from "@near-js/types";
import { config, isTestnet } from "../config";
import { requestSignature } from "@neardefi/shade-agent-js";
import { base58Decode } from "./common";
import { chainSignatureContract } from "../infra/chainSignature";
import { createLogger } from "./logger";

const log = createLogger("near");

const { uint8ArrayToHex } = utils.cryptography;

export const NEAR_DEFAULT_PATH = "near-1";

const networkId = isTestnet ? "testnet" : "mainnet";
const nodeUrl = config.nearRpcUrls[0] || (isTestnet ? "https://rpc.testnet.near.org" : "https://rpc.mainnet.near.org");

const nearProvider = new JsonRpcProvider({ url: nodeUrl });

const NearAdapter = new chainAdapters.near.NEAR({
  rpcUrl: nodeUrl,
  networkId,
  contract: chainSignatureContract,
});

export function getNearProvider() {
  return nearProvider;
}

/**
 * Extract tx hash from a FinalExecutionOutcome.
 * The SDK types `transaction` as `any`, so we centralise the access here.
 */
export function extractTxHash(result: FinalExecutionOutcome): string {
  const r = result as any;
  return r.transaction?.hash || r.transaction_outcome?.id;
}

// Minimum NEAR to fund implicit account (0.01 NEAR)
const IMPLICIT_ACCOUNT_FUNDING = BigInt("10000000000000000000000");

// Cache the relayer account
let cachedRelayer: { account: Account; publicKey: string } | null = null;

/**
 * Get the relayer account (agent's account that pays for gas and funds implicit accounts)
 */
async function getRelayerAccount(): Promise<{ account: Account; publicKey: string }> {
  if (!config.nearSeedPhrase) {
    throw new Error("NEAR_SEED_PHRASE not configured");
  }

  if (cachedRelayer) {
    return cachedRelayer;
  }

  const { secretKey, publicKey } = parseSeedPhrase(config.nearSeedPhrase);

  const pubKeyBase58 = publicKey.replace("ed25519:", "");
  const pubKeyBytes = bs58.decode(pubKeyBase58);
  const accountId = Buffer.from(pubKeyBytes).toString("hex");

  log.info(`Relayer account from seed phrase: ${accountId}`);

  const signer = KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`);
  const account = new Account(accountId, nearProvider, signer);

  cachedRelayer = { account, publicKey };
  return cachedRelayer;
}

/**
 * Ensures the implicit account exists by funding it if needed.
 */
export async function ensureNearAccountFunded(accountId: string): Promise<void> {
  const exists = await ensureNearAccountExists(accountId);
  if (exists) {
    log.info(`Account ${accountId} already exists`);
    return;
  }

  log.info(`Creating implicit account ${accountId} by funding with NEAR`);

  const { account: relayer } = await getRelayerAccount();
  const result = await relayer.transfer({
    receiverId: accountId,
    amount: IMPLICIT_ACCOUNT_FUNDING,
    token: NEAR,
  });

  const txHash = extractTxHash(result as FinalExecutionOutcome);
  log.info(`Funded implicit account ${accountId}: ${txHash}`);

  // Wait for account to be created
  await new Promise(resolve => setTimeout(resolve, 2000));
}

export interface NearAgentAccount {
  accountId: string;
  publicKey: string;
  derivationPath: string;
}

/**
 * Derives a NEAR implicit account from chain signatures.
 * The implicit account ID is the hex-encoded 32-byte ed25519 public key.
 */
export async function deriveNearAgentAccount(
  path = NEAR_DEFAULT_PATH,
  userDestination?: string,
): Promise<NearAgentAccount> {
  const accountId = config.shadeContractId;
  if (!accountId) throw new Error("NEXT_PUBLIC_contractId not configured");

  let derivationPath = path;
  if (userDestination) {
    derivationPath = `${derivationPath},${userDestination}`;
  }

  const derivedKey = await chainSignatureContract.getDerivedPublicKey({
    path: derivationPath,
    predecessor: accountId,
    IsEd25519: true,
  });

  if (typeof derivedKey !== "string" || (!derivedKey.startsWith("ed25519:") && !derivedKey.startsWith("Ed25519:"))) {
    throw new Error(`Expected ed25519 key, got: ${derivedKey}`);
  }

  const keyBase58 = derivedKey.slice(8);
  const keyBytes = base58Decode(keyBase58);

  if (keyBytes.length !== 32) {
    throw new Error(`Expected 32-byte ed25519 key, got ${keyBytes.length} bytes`);
  }

  const implicitAccountId = Buffer.from(keyBytes).toString("hex");
  const normalizedPublicKey = `ed25519:${keyBase58}`;

  return {
    accountId: implicitAccountId,
    publicKey: normalizedPublicKey,
    derivationPath,
  };
}

export interface NearFunctionCallRequest {
  from: NearAgentAccount;
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

export interface NearPreparedTransaction {
  transaction: NearTransaction;
  hashToSign: Uint8Array;
  serialized: Uint8Array;
}

/**
 * Ensures the implicit account exists by checking if it has any balance.
 * If not, the account needs to be funded before it can transact.
 */
export async function ensureNearAccountExists(accountId: string): Promise<boolean> {
  try {
    await nearProvider.query({
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return true;
  } catch (e: any) {
    const isNotFound =
      e.message?.includes("does not exist") ||
      e.type === "AccountDoesNotExist";
    if (isNotFound) {
      return false;
    }
    throw e;
  }
}

/**
 * Builds a NEAR function call transaction and returns it ready for signing.
 */
export async function prepareNearFunctionCallTx(
  request: NearFunctionCallRequest,
): Promise<NearPreparedTransaction> {
  const { from, receiverId, methodName, args, gas, deposit } = request;

  const publicKey = PublicKey.fromString(from.publicKey);

  // Get access key nonce
  let nonce = BigInt(0);
  try {
    const accessKey = await nearProvider.query({
      request_type: "view_access_key",
      finality: "final",
      account_id: from.accountId,
      public_key: from.publicKey,
    });
    nonce = BigInt((accessKey as unknown as { nonce: number }).nonce);
  } catch (e: any) {
    if (!e.message?.includes("does not exist")) throw e;
  }

  // Get recent block hash
  const block = await nearProvider.block({ finality: "final" });
  const blockHash = baseDecode(block.header.hash);

  // Create function call action
  const actions: Action[] = [
    actionCreators.functionCall(methodName, args, gas, deposit),
  ];

  // Build the transaction
  const nextNonce = nonce + 1n;
  if (nextNonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Nonce ${nextNonce} exceeds Number.MAX_SAFE_INTEGER`);
  }
  const transaction = nearCreateTransaction(
    from.accountId,
    publicKey,
    receiverId,
    Number(nextNonce),
    actions,
    blockHash,
  );

  // Serialize and hash for signing
  const serialized = nearEncodeTransaction(transaction);
  const hashToSign = crypto.createHash("sha256").update(serialized).digest();

  return {
    transaction,
    hashToSign: new Uint8Array(hashToSign),
    serialized: new Uint8Array(serialized),
  };
}

/**
 * Signs a NEAR transaction hash using chain signatures.
 */
export async function signNearTransaction(
  hashToSign: Uint8Array,
  derivationPath: string,
): Promise<Uint8Array> {
  const signRes = await requestSignature({
    path: derivationPath,
    payload: uint8ArrayToHex(hashToSign),
    keyType: "Eddsa",
  });

  if (!signRes.signature) {
    throw new Error("Failed to get signature from chain signatures");
  }

  let sigData: Uint8Array;
  if (typeof signRes.signature === "string") {
    sigData = signRes.signature.startsWith("0x")
      ? Buffer.from(signRes.signature.slice(2), "hex")
      : Buffer.from(signRes.signature, "hex");
  } else {
    sigData = new Uint8Array(64);
    sigData.set(Buffer.from(signRes.signature.r, "hex"), 0);
    sigData.set(Buffer.from(signRes.signature.s, "hex"), 32);
  }

  if (sigData.length !== 64) {
    throw new Error(`Expected 64-byte ed25519 signature, got ${sigData.length} bytes`);
  }

  return sigData;
}

/**
 * Finalizes a NEAR transaction by attaching the signature.
 */
export function finalizeNearTransaction(
  transaction: NearTransaction,
  signature: Uint8Array,
): NearSignedTransaction {
  return new NearSignedTransaction({
    transaction,
    signature: new NearSignature({
      keyType: KeyType.ED25519,
      data: signature,
    }),
  });
}

/**
 * Broadcasts a signed NEAR transaction.
 */
export async function broadcastNearTx(signedTx: NearSignedTransaction): Promise<string> {
  const result = await nearProvider.sendTransaction(signedTx);
  const txHash = extractTxHash(result as FinalExecutionOutcome);
  log.info(`Transaction broadcast: ${txHash}`);
  return txHash;
}

/**
 * Helper to execute a full NEAR function call flow:
 * 1. Prepare transaction
 * 2. Sign with chain signatures
 * 3. Finalize and broadcast
 */
export async function executeNearFunctionCall(
  request: NearFunctionCallRequest,
): Promise<string> {
  const { transaction, hashToSign } = await prepareNearFunctionCallTx(request);

  const signature = await signNearTransaction(hashToSign, request.from.derivationPath);

  const signedTx = finalizeNearTransaction(transaction, signature);

  return broadcastNearTx(signedTx);
}

// Gas constants
export const GAS_FOR_FT_TRANSFER_CALL = BigInt("100000000000000"); // 100 TGas
export const ONE_YOCTO = BigInt("1");
export const ZERO_DEPOSIT = BigInt("0");

// ─── NEAR Transaction Verification ──────────────────────────────────────────

export interface NearTransactionResult {
  /** Whether the transaction succeeded */
  success: boolean;
  /** The receiver of the transaction */
  receiverId: string;
  /** Actions in the transaction */
  actions: Array<{
    type: string;
    methodName?: string;
    args?: Record<string, unknown>;
  }>;
}

/**
 * Verify a NEAR transaction on-chain by querying RPC for the TX outcome.
 *
 * @param txHash - The transaction hash (base58 encoded)
 * @param senderAccountId - The sender's NEAR account ID
 * @returns Transaction result including receiver and actions
 */
export async function getNearTransactionStatus(
  txHash: string,
  senderAccountId: string,
): Promise<NearTransactionResult> {
  // txStatus returns FinalExecutionOutcome but transaction/status fields are typed as any in the SDK
  const result = await nearProvider.txStatus(txHash, senderAccountId, "FINAL") as any;

  const success = !result.status?.Failure;
  const receiverId = result.transaction?.receiver_id || "";
  const rawActions = result.transaction?.actions || [];

  const actions = rawActions.map((action: any) => {
    if (action.FunctionCall) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(Buffer.from(action.FunctionCall.args, "base64").toString("utf8"));
      } catch {
        // args may not be JSON
      }
      return {
        type: "FunctionCall",
        methodName: action.FunctionCall.method_name,
        args,
      };
    }
    if (action.Transfer) {
      return { type: "Transfer" };
    }
    return { type: Object.keys(action)[0] || "Unknown" };
  });

  return { success, receiverId, actions };
}
