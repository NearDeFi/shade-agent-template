import Redis from "ioredis";
import { config } from "../config";
import { createLogger } from "../utils/logger";

const log = createLogger("redis");

/**
 * Shared Redis client for state storage (status, orders, etc.).
 * Queue modules (RedisQueueClient) maintain their own connections
 * since they use blocking operations (BRPOPLPUSH).
 */
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on("error", (err) => {
  log.error("Redis connection error (shared)", { err: String(err) });
});
