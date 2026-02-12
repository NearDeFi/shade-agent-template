import { chainAdapters } from "chainsig.js";
import {
  address,
  createSolanaRpc,
  pipe,
  createTransactionMessage,
  appendTransactionMessageInstructions,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  type Address,
  type IInstruction,
} from "@solana/kit";
import { fetchAddressLookupTable } from "@solana-program/address-lookup-table";
import { config } from "../config";
import { chainSignatureContract } from "../infra/chainSignature";
import { createDummySigner } from "./chainSignature";

export const SOLANA_DEFAULT_PATH = "solana-1";

/** Native SOL mint address */
export const SOL_NATIVE_MINT: Address = address("So11111111111111111111111111111111111111112");

// ─── RPC Singleton ──────────────────────────────────────────────────────────────

export type SolanaRpc = ReturnType<typeof createSolanaRpc>;

let solanaRpc = createSolanaRpc(config.solRpcUrl);

export function getSolanaRpc() {
  return solanaRpc;
}

/** @deprecated Use `getSolanaRpc()` instead */
export const getSolanaConnection = getSolanaRpc;

export function setSolanaRpcForTest(rpc: SolanaRpc) {
  solanaRpc = rpc as any;
}

/** @deprecated Use `setSolanaRpcForTest()` instead */
export const setSolanaConnectionForTest = setSolanaRpcForTest;

// ─── Adapter ────────────────────────────────────────────────────────────────────

export function createSolanaAdapter() {
  return new chainAdapters.solana.Solana({
    // chainsig.js still expects a Connection-shaped object but only uses it
    // for key derivation, not for RPC calls. Pass `solanaRpc` with `as any`
    // because the adapter's runtime usage is compatible.
    solanaConnection: solanaRpc as any,
    contract: chainSignatureContract,
  }) as any;
}

export const SolanaAdapter = createSolanaAdapter();

// ─── Key Derivation ─────────────────────────────────────────────────────────────

export async function deriveAgentPublicKey(
  path = SOLANA_DEFAULT_PATH,
  userDestination?: string,
): Promise<Address> {
  const accountId = config.shadeContractId;
  if (!accountId) throw new Error("NEXT_PUBLIC_contractId not configured");

  let derivationPath = path;
  if (userDestination) {
    derivationPath = `${derivationPath},${userDestination}`;
  }

  const { publicKey } = await SolanaAdapter.deriveAddressAndPublicKey(
    accountId,
    derivationPath,
  );
  return address(publicKey as string);
}

// ─── Compiled Transaction Type ──────────────────────────────────────────────────

/**
 * Simplified compiled transaction type that avoids @solana/kit nominal types.
 * This is the standard interchange type across all flow files.
 */
export interface CompiledTransaction {
  messageBytes: Uint8Array;
  signatures: Record<Address, Uint8Array>;
}

// ─── Transaction Building ───────────────────────────────────────────────────────

/**
 * Build and compile a Solana V0 transaction from instructions.
 * This is the shared transaction builder used across all flow files.
 */
/** Map of lookup table address → addresses stored in it */
export type AddressesByLookupTable = Record<Address, Address[]>;

export async function buildAndCompileTransaction(opts: {
  instructions: IInstruction[];
  feePayer: Address;
  rpc: SolanaRpc;
  addressLookupTables?: AddressesByLookupTable;
}): Promise<CompiledTransaction> {
  const feePayerSigner = createDummySigner(opts.feePayer);
  const { value: blockhash } = await opts.rpc.getLatestBlockhash().send();

  let txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => appendTransactionMessageInstructions(opts.instructions, tx),
    (tx) => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  );

  if (opts.addressLookupTables && Object.keys(opts.addressLookupTables).length > 0) {
    txMessage = compressTransactionMessageUsingAddressLookupTables(
      txMessage,
      opts.addressLookupTables,
    );
  }

  const rawCompiledTx = compileTransaction(txMessage);

  return {
    messageBytes: new Uint8Array(rawCompiledTx.messageBytes),
    signatures: Object.fromEntries(
      Object.entries(rawCompiledTx.signatures)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, new Uint8Array(v!)]),
    ) as Record<Address, Uint8Array>,
  };
}

// ─── Transaction Signing ────────────────────────────────────────────────────────

/**
 * Attach a single signature at the first position of a compiled transaction.
 */
export function attachSignatureToCompiledTx(
  tx: CompiledTransaction,
  signerAddress: Address,
  signature: Uint8Array,
): CompiledTransaction {
  return {
    ...tx,
    signatures: {
      ...tx.signatures,
      [signerAddress]: signature,
    },
  };
}

/**
 * Attach multiple signatures to a compiled transaction.
 */
export function attachMultipleSignaturesToCompiledTx(
  tx: CompiledTransaction,
  signaturePairs: Array<{ address: Address; signature: Uint8Array }>,
): CompiledTransaction {
  const newSignatures = { ...tx.signatures };
  for (const { address: addr, signature } of signaturePairs) {
    newSignatures[addr] = signature;
  }
  return { ...tx, signatures: newSignatures };
}

// ─── Transaction Broadcasting ───────────────────────────────────────────────────

/**
 * Serialize a CompiledTransaction to Solana wire format and broadcast via RPC.
 * Polls for confirmation.
 */
export async function broadcastSolanaTx(
  compiledTx: CompiledTransaction,
  skipConfirmation = false,
): Promise<string> {
  const rpc = getSolanaRpc();

  // Serialize to wire format: [num_signatures (1 byte)] + [signatures (64 bytes each)] + [message]
  const signatureAddresses = Object.keys(compiledTx.signatures) as Address[];
  const numSignatures = signatureAddresses.length;
  const totalSignatureBytes = numSignatures * 64;
  const serialized = new Uint8Array(1 + totalSignatureBytes + compiledTx.messageBytes.length);

  serialized[0] = numSignatures;
  let offset = 1;
  for (const addr of signatureAddresses) {
    serialized.set(compiledTx.signatures[addr], offset);
    offset += 64;
  }
  serialized.set(compiledTx.messageBytes, offset);

  const base64Tx = Buffer.from(serialized).toString("base64");
  // `as any`: @solana/kit expects a branded transaction type, not plain string
  const signature = await rpc.sendTransaction(base64Tx as any, {
    encoding: "base64",
    skipPreflight: false,
    preflightCommitment: "confirmed",
  }).send();

  if (!skipConfirmation) {
    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { value: statuses } = await rpc.getSignatureStatuses([signature]).send();
      const status = statuses[0];
      if (status) {
        if (status.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
        }
        return signature;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Transaction confirmation timed out after ${maxAttempts}s for ${signature}`);
  }

  return signature;
}

// ─── Kamino RPC ──────────────────────────────────────────────────────────────

export function createKaminoRpc(solRpcUrl: string) {
  return createSolanaRpc(solRpcUrl);
}

// ─── Instruction Helpers ──────────────────────────────────────────────────────

/**
 * Deserialize a Jupiter swap instruction from JSON to Kit IInstruction.
 */
export function deserializeInstruction(instruction: {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}): IInstruction {
  return {
    programAddress: address(instruction.programId),
    accounts: instruction.accounts.map((acc) => ({
      address: address(acc.pubkey),
      role: acc.isSigner
        ? (acc.isWritable ? 3 : 2)
        : (acc.isWritable ? 1 : 0),
    })) as any,
    data: new Uint8Array(Buffer.from(instruction.data, "base64")),
  };
}

/**
 * Fetch address lookup tables from the chain and return them in Kit format.
 */
export async function getAddressLookupTableAccounts(
  rpc: SolanaRpc,
  addresses: string[],
): Promise<AddressesByLookupTable> {
  if (addresses.length === 0) return {} as AddressesByLookupTable;

  const result: AddressesByLookupTable = {} as AddressesByLookupTable;
  for (const addr of addresses) {
    try {
      const tableAccount = await fetchAddressLookupTable(rpc, address(addr));
      result[address(addr)] = tableAccount.data.addresses;
    } catch {
      // Skip tables that can't be fetched (same as legacy behavior)
    }
  }
  return result;
}

// ─── High-Level Transaction Helpers ─────────────────────────────────────────────

// Import here to avoid circular dependency at module load
import { signWithNearChainSignatures } from "./chainSignature";

/**
 * Sign and broadcast a Solana transaction with a single signer.
 * Used for flows where only the user agent signs (e.g., Jupiter swap).
 */
export async function signAndBroadcastSingleSigner(
  compiledTx: CompiledTransaction,
  userDestination: string,
): Promise<string> {
  const signature = await signWithNearChainSignatures(
    compiledTx.messageBytes,
    userDestination,
  );

  const agentAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, userDestination);
  const finalized = attachSignatureToCompiledTx(compiledTx, agentAddress, signature);
  return broadcastSolanaTx(finalized);
}

/**
 * Sign and broadcast a Solana transaction with dual signers (fee payer + user agent).
 * Used for flows where both the base agent pays fees and user agent owns tokens.
 */
export async function signAndBroadcastDualSigner(
  compiledTx: CompiledTransaction,
  userDestination: string,
): Promise<string> {
  const feePayerAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);
  const userAgentAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, userDestination);

  const feePayerSignature = await signWithNearChainSignatures(
    compiledTx.messageBytes,
    undefined,
  );
  const userAgentSignature = await signWithNearChainSignatures(
    compiledTx.messageBytes,
    userDestination,
  );

  const finalized = attachMultipleSignaturesToCompiledTx(compiledTx, [
    { address: feePayerAddress, signature: feePayerSignature },
    { address: userAgentAddress, signature: userAgentSignature },
  ]);

  return broadcastSolanaTx(finalized);
}
