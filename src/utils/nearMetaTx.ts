import { JsonRpcProvider } from "@near-js/providers";
import { NEAR } from "@near-js/tokens";
import { actionCreators, SignedDelegate, Action, encodeDelegateAction, buildDelegateAction, Signature } from "@near-js/transactions";
import { PublicKey, KeyType } from "@near-js/crypto";
import type { FinalExecutionOutcome } from "@near-js/types";
import { config, isTestnet } from "../config";
import { deriveNearImplicitAccount, NEAR_DEFAULT_PATH } from "./chainSignature";
import { getNearProvider, extractTxHash } from "./near";
import { getRelayerAccount } from "../infra/relayerAccount";
import { requestSignature } from "@neardefi/shade-agent-js";
import { utils } from "chainsig.js";
import crypto from "crypto";
import { createLogger } from "./logger";

const log = createLogger("nearMetaTx");

const { uint8ArrayToHex } = utils.cryptography;

import { GAS_FOR_FT_TRANSFER_CALL, IMPLICIT_ACCOUNT_FUNDING } from "../constants";

export { GAS_FOR_FT_TRANSFER_CALL };
export const ONE_YOCTO = BigInt("1");
export const ZERO_DEPOSIT = BigInt("0");

const DELEGATE_ACTION_TTL = 120;

const networkId = isTestnet ? "testnet" : "mainnet";
const nodeUrl = config.nearRpcUrls[0] || (isTestnet ? "https://rpc.testnet.near.org" : "https://rpc.mainnet.near.org");

/**
 * Ensure the implicit account exists by funding it if needed.
 * This is needed before tokens can be received or meta transactions executed.
 */
export async function ensureImplicitAccountExists(
  provider: JsonRpcProvider,
  accountId: string,
  publicKeyStr: string,
): Promise<void> {
  try {
    // Check if account exists by querying its state
    await provider.query({
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    log.info(`Implicit account ${accountId} already exists`);
  } catch (e: any) {
    // Check for account not existing - can be in message or type
    const isAccountNotFound =
      e.message?.includes("does not exist") ||
      e.type === "AccountDoesNotExist";

    if (!isAccountNotFound) throw e;

    // Account doesn't exist - fund it to create using the relayer account
    log.info(`Creating implicit account ${accountId} by funding with NEAR`);

    const { account: relayer } = await getRelayerAccount();
    const result = await relayer.transfer({
      receiverId: accountId,
      amount: IMPLICIT_ACCOUNT_FUNDING,
      token: NEAR,
    });

    const txHash = extractTxHash(result as FinalExecutionOutcome);
    log.info(`Funded implicit account ${accountId}: ${txHash}`);

    // Wait a bit for the account to be created
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

/**
 * Build and sign a DelegateAction using chain signatures, then relay it
 */
export async function executeMetaTransaction(
  userDestination: string,
  receiverId: string,
  actions: Action[],
): Promise<string> {
  const provider = getNearProvider();

  // Derive the user's NEAR implicit account
  // userDestination goes in 3rd parameter for custody isolation
  const { accountId: senderId, publicKey: publicKeyStr } = await deriveNearImplicitAccount(
    NEAR_DEFAULT_PATH,
    undefined, // nearPublicKey - not used
    userDestination,
  );
  const publicKey = PublicKey.fromString(publicKeyStr);

  log.info(`Derived account for userDestination=${userDestination}: ${senderId}`);

  // Ensure the implicit account exists (fund it if needed)
  await ensureImplicitAccountExists(provider, senderId, publicKeyStr);

  log.info(`Building delegate action for ${senderId} -> ${receiverId}`);

  // Get nonce and block height
  let nonce = BigInt(0);
  try {
    const accessKey = await provider.query({
      request_type: "view_access_key",
      finality: "final",
      account_id: senderId,
      public_key: publicKeyStr,
    });
    nonce = BigInt((accessKey as unknown as { nonce: number }).nonce);
  } catch (e: any) {
    if (!e.message?.includes("does not exist")) throw e;
  }

  const block = await provider.block({ finality: "final" });
  const maxBlockHeight = BigInt(block.header.height) + BigInt(DELEGATE_ACTION_TTL);

  // Build the delegate action
  const delegateAction = buildDelegateAction({
    senderId,
    receiverId,
    actions,
    nonce: nonce + 1n,
    maxBlockHeight,
    publicKey,
  });

  // Hash and sign with chain signatures
  const hash = crypto.createHash("sha256").update(encodeDelegateAction(delegateAction)).digest();
  const derivationPath = `${NEAR_DEFAULT_PATH},${userDestination}`;

  const signRes = await requestSignature({
    path: derivationPath,
    payload: uint8ArrayToHex(hash),
    keyType: "Eddsa",
  });

  if (!signRes.signature) {
    throw new Error("Failed to get signature from chain signatures");
  }

  // Parse signature
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

  const signedDelegate = new SignedDelegate({
    delegateAction,
    signature: new Signature({ keyType: KeyType.ED25519, data: sigData }),
  });

  // Submit via relayer
  const { account: relayer } = await getRelayerAccount();
  log.info(`Relaying via ${relayer.accountId}`);

  const result = await relayer.signAndSendTransaction({
    receiverId: senderId,
    actions: [actionCreators.signedDelegate(signedDelegate)],
  });

  const txHash = extractTxHash(result as FinalExecutionOutcome);
  log.info(`Transaction: ${txHash}`);
  return txHash;
}

/**
 * Create a function call action
 */
export function createFunctionCallAction(
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint = GAS_FOR_FT_TRANSFER_CALL,
  deposit: bigint = ZERO_DEPOSIT,
): Action {
  return actionCreators.functionCall(methodName, args, gas, deposit);
}
