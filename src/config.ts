import dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: ".env.development.local" });
}

import { createLogger } from "./utils/logger";

const log = createLogger("config");

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

function parseCorsAllowedOrigins(): string[] {
  const value = process.env.CORS_ALLOWED_ORIGINS;
  if (!value) return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const config = {
  nearRpcUrls: parseNearRpcUrls(),
  nearSeedPhrase: process.env.NEAR_SEED_PHRASE || "",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  redisQueueKey: process.env.REDIS_QUEUE_KEY || "near:intents",
  redisVisibilityMs:
    parseInt(process.env.REDIS_VISIBILITY_MS || "", 10) || 30_000,
  redisRecoveryIntervalMs:
    parseInt(process.env.REDIS_RECOVERY_INTERVAL_MS || "", 10) || 5_000,
  redisRecoveryBatchSize:
    parseInt(process.env.REDIS_RECOVERY_BATCH_SIZE || "", 10) || 100,
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
  intentsPollerConcurrency:
    parseInt(process.env.INTENTS_POLLER_CONCURRENCY || "", 10) || 5,
  orderPollerPairConcurrency:
    parseInt(process.env.ORDER_POLLER_PAIR_CONCURRENCY || "", 10) || 4,
  /** Permission contract ID for self-custodial operations */
  permissionContractId:
    process.env.PERMISSION_CONTRACT_ID ||
    (isTestnet ? "permission.shade.testnet" : "permission.shade.near"),
  /** Secret key required for manual order funding endpoint (disabled when empty) */
  orderFundingApiKey: process.env.ORDER_FUNDING_API_KEY || "",
  /** Reconciliation timeout for orders stuck in "triggered" state (default: 5 minutes) */
  orderTriggeredTimeoutMs:
    parseInt(process.env.ORDER_TRIGGERED_TIMEOUT_MS || "", 10) || 5 * 60 * 1000,
  /** Optional explicit CORS allow-list. Empty list falls back to wildcard. */
  corsAllowedOrigins: parseCorsAllowedOrigins(),
};

function validateConfig(): void {
  const warnings: string[] = [];

  if (!config.nearSeedPhrase) {
    warnings.push("NEAR_SEED_PHRASE is not set; signing operations will fail");
  }
  if (!config.shadeContractId) {
    // Already warned above, but include in summary
    warnings.push("NEXT_PUBLIC_contractId is not set; derived keys will be empty");
  }
  if (config.enableQueue && config.redisUrl === "redis://127.0.0.1:6379" && process.env.NODE_ENV === "production") {
    warnings.push("REDIS_URL is using localhost default in production");
  }

  if (warnings.length > 0) {
    for (const w of warnings) {
      log.warn(w);
    }
  }

  log.info("Config loaded", {
    network: config.chainSignatureNetwork,
    enableQueue: config.enableQueue,
    dryRunSwaps: config.dryRunSwaps,
    queueConcurrency: config.queueConcurrency,
  });
}

validateConfig();
