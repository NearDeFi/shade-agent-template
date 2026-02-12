import { Account } from "@near-js/accounts";
import { KeyPairSigner } from "@near-js/signers";
import { parseSeedPhrase } from "near-seed-phrase";
import bs58 from "bs58";
import { config } from "../config";
import { getNearProvider } from "../utils/near";
import { createLogger } from "../utils/logger";

const log = createLogger("relayer");

let cachedRelayer: { account: Account; publicKey: string } | null = null;

/**
 * Get the relayer account (agent's account that pays for gas and funds implicit accounts).
 * Uses the NEAR_SEED_PHRASE to derive the account. Cached after first call.
 */
export async function getRelayerAccount(): Promise<{ account: Account; publicKey: string }> {
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
  const account = new Account(accountId, getNearProvider(), signer);

  cachedRelayer = { account, publicKey };
  return cachedRelayer;
}
