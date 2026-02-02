import dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: ".env.development.local" });
}

const chainSignatureNetwork =
  (process.env.NEAR_NETWORK as "mainnet" | "testnet") || "mainnet";
export const isTestnet = chainSignatureNetwork === "testnet";

// Parse NEAR RPC URLs from NEAR_RPC_JSON if provided
function parseNearRpcUrls(): string[] {
  const rpcJson = process.env.NEAR_RPC_JSON;
  if (!rpcJson) return [];
  try {
    const parsed = JSON.parse(rpcJson);
    if (parsed.nearRpcProviders && Array.isArray(parsed.nearRpcProviders)) {
      return parsed.nearRpcProviders.map(
        (p: { connectionInfo?: { url?: string } }) => p.connectionInfo?.url,
      ).filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}

export const config = {
  nearRpcUrls: parseNearRpcUrls(),
  nearSeedPhrase: process.env.NEAR_SEED_PHRASE || "",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  redisQueueKey: process.env.REDIS_QUEUE_KEY || "near:intents",
  redisVisibilityMs:
    parseInt(process.env.REDIS_VISIBILITY_MS || "", 10) || 30_000,
  deadLetterKey: process.env.REDIS_DEAD_LETTER_KEY || "near:intents:dead-letter",
  maxIntentAttempts:
    parseInt(process.env.MAX_INTENT_ATTEMPTS || "", 10) || 3,
  intentRetryBackoffMs:
    parseInt(process.env.INTENT_RETRY_BACKOFF_MS || "", 10) || 1_000,
  statusTtlSeconds:
    parseInt(process.env.STATUS_TTL_SECONDS || "", 10) || 24 * 60 * 60,
  jupiterMaxAttempts:
    parseInt(process.env.JUPITER_MAX_ATTEMPTS || "", 10) || 3,
  jupiterRetryBackoffMs:
    parseInt(process.env.JUPITER_RETRY_BACKOFF_MS || "", 10) || 500,
  priceFeedMaxAttempts:
    parseInt(process.env.PRICE_FEED_MAX_ATTEMPTS || "", 10) || 3,
  priceFeedRetryBackoffMs:
    parseInt(process.env.PRICE_FEED_RETRY_BACKOFF_MS || "", 10) || 500,
  ethRpcUrl: process.env.ETH_RPC_URL || "https://sepolia.drpc.org",
  baseRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  arbRpcUrl: process.env.ARB_RPC_URL || "https://arb1.arbitrum.io/rpc",
  bnbRpcUrl: process.env.BNB_RPC_URL || "https://bsc-dataseed.binance.org",
  zeroExApiKey: process.env.ZERO_EX_API_KEY || "",
  zeroExMaxAttempts:
    parseInt(process.env.ZERO_EX_MAX_ATTEMPTS || "", 10) || 3,
  zeroExRetryBackoffMs:
    parseInt(process.env.ZERO_EX_RETRY_BACKOFF_MS || "", 10) || 500,
  ethContractAddress:
    process.env.ETH_CONTRACT_ADDRESS ||
    "0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8",
  solRpcUrl:
    process.env.SOL_RPC_URL ||
    (isTestnet
      ? "https://api.devnet.solana.com"
      : "https://api.mainnet-beta.solana.com"),
  jupiterBaseUrl:
    process.env.JUPITER_API_URL || "https://quote-api.jup.ag/v6",
  jupiterCluster: process.env.JUPITER_CLUSTER || (isTestnet ? "devnet" : "mainnet"),
  shadeContractId: process.env.NEXT_PUBLIC_contractId || "",
  dryRunSwaps: process.env.DRY_RUN_SWAPS === "true",
  intentsQuoteUrl: process.env.INTENTS_QUOTE_URL || "http://localhost:8787",
  chainSignatureContractId:
    process.env.CHAIN_SIGNATURE_CONTRACT_ID ||
    (isTestnet ? "v1.signer-prod.testnet" : "v1.signer"),
  chainSignatureNetwork,
  chainSignatureMpcKey:
    process.env.CHAIN_SIGNATURE_MPC_KEY ||
    "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya",
  enableQueue:
    process.env.ENABLE_QUEUE === "true"
      ? true
      : process.env.ENABLE_QUEUE === "false"
        ? false
        : !isTestnet,
  /** Number of intents to process in parallel (default: 5) */
  queueConcurrency:
    parseInt(process.env.QUEUE_CONCURRENCY || "", 10) || 5,
  /** Permission contract ID for self-custodial operations */
  permissionContractId:
    process.env.PERMISSION_CONTRACT_ID ||
    (isTestnet ? "permission.shade.testnet" : "permission.shade.near"),
};

if (!config.shadeContractId) {
  console.warn("NEXT_PUBLIC_contractId is not set; derived keys will be empty");
}
