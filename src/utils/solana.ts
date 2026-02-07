import { chainAdapters } from "chainsig.js";
import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../config";
import { chainSignatureContract } from "../infra/chainSignature";

export const SOLANA_DEFAULT_PATH = "solana-1";

const solanaConnection = new Connection(config.solRpcUrl, "confirmed");

export const SolanaAdapter = new chainAdapters.solana.Solana({
  solanaConnection,
  contract: chainSignatureContract,
}) as any;

export function getSolanaConnection() {
  return solanaConnection;
}

export async function deriveAgentPublicKey(
  path = SOLANA_DEFAULT_PATH,
  userDestination?: string,
) {
  const accountId = config.shadeContractId;
  if (!accountId) throw new Error("NEXT_PUBLIC_contractId not configured");

  // Build derivation path including user destination for custody isolation
  // Each unique userDestination gets their own derived agent account
  let derivationPath = path;
  if (userDestination) {
    derivationPath = `${derivationPath},${userDestination}`;
  }

  const { publicKey } = await SolanaAdapter.deriveAddressAndPublicKey(
    accountId,
    derivationPath,
  );
  return new PublicKey(publicKey as string);
}

export function attachSignatureToVersionedTx(
  tx: VersionedTransaction,
  signature: Uint8Array,
): VersionedTransaction {
  const signatures = tx.signatures.length
    ? tx.signatures
    : Array(tx.message.header.numRequiredSignatures).fill(
        new Uint8Array(64),
      );
  signatures[0] = signature;
  const signed = new VersionedTransaction(tx.message, signatures);
  return signed;
}

/**
 * Attach multiple signatures to a versioned transaction at specified indices.
 * Used when a transaction requires multiple signers (e.g., fee payer + token owner).
 * @param tx - The transaction to sign
 * @param signaturePairs - Array of {signature, index} pairs matching signer order in the message
 */
export function attachMultipleSignaturesToVersionedTx(
  tx: VersionedTransaction,
  signaturePairs: Array<{ signature: Uint8Array; index: number }>,
): VersionedTransaction {
  const signatures = tx.signatures.length
    ? [...tx.signatures]
    : Array(tx.message.header.numRequiredSignatures).fill(
        new Uint8Array(64),
      );

  for (const { signature, index } of signaturePairs) {
    signatures[index] = signature;
  }

  return new VersionedTransaction(tx.message, signatures);
}

export async function broadcastSolanaTx(tx: VersionedTransaction, skipConfirmation = false) {
  const connection = getSolanaConnection();

  // Fetch the blockhash commitment BEFORE sending so we confirm against
  // the same blockhash the transaction was built with.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

  const sig = await connection.sendRawTransaction(tx.serialize());

  if (!skipConfirmation) {
    const confirmation = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
  }

  return sig;
}

// ─── Instruction Helpers ──────────────────────────────────────────────────────

export function deserializeInstruction(instruction: {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(instruction.data, "base64"),
  });
}

export async function getAddressLookupTableAccounts(
  connection: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  if (addresses.length === 0) return [];

  const accounts = await connection.getMultipleAccountsInfo(
    addresses.map((addr) => new PublicKey(addr)),
  );

  return accounts
    .map((account, index) => {
      if (!account) return null;
      return new AddressLookupTableAccount({
        key: new PublicKey(addresses[index]),
        state: AddressLookupTableAccount.deserialize(account.data),
      });
    })
    .filter((account): account is AddressLookupTableAccount => account !== null);
}

// ─── High-Level Transaction Helpers ─────────────────────────────────────────────

// Import here to avoid circular dependency at module load
import { signWithNearChainSignatures } from "./chainSignature";

/**
 * Sign and broadcast a Solana transaction with a single signer.
 * Used for flows where only the user agent signs (e.g., Jupiter swap).
 *
 * @param transaction - The versioned transaction to sign and broadcast
 * @param userDestination - The user's destination address for key derivation
 * @returns Transaction signature (txId)
 */
export async function signAndBroadcastSingleSigner(
  transaction: VersionedTransaction,
  userDestination: string,
): Promise<string> {
  const signature = await signWithNearChainSignatures(
    transaction.message.serialize(),
    userDestination,
  );
  const finalized = attachSignatureToVersionedTx(transaction, signature);
  return broadcastSolanaTx(finalized);
}

/**
 * Sign and broadcast a Solana transaction with dual signers (fee payer + user agent).
 * Used for flows where both the base agent pays fees and user agent owns tokens.
 *
 * @param transaction - The versioned transaction to sign and broadcast
 * @param serializedMessage - The serialized message bytes to sign
 * @param userDestination - The user's destination address for key derivation
 * @returns Transaction signature (txId)
 */
export async function signAndBroadcastDualSigner(
  transaction: VersionedTransaction,
  serializedMessage: Uint8Array,
  userDestination: string,
): Promise<string> {
  const feePayerSignature = await signWithNearChainSignatures(
    serializedMessage,
    undefined, // base agent path
  );
  const userAgentSignature = await signWithNearChainSignatures(
    serializedMessage,
    userDestination,
  );

  const finalized = attachMultipleSignaturesToVersionedTx(transaction, [
    { signature: feePayerSignature, index: 0 },
    { signature: userAgentSignature, index: 1 },
  ]);

  return broadcastSolanaTx(finalized);
}
