import Redis from "ioredis";
import { config } from "../config";
import { IntentMessage } from "./types";
import { createLogger } from "../utils/logger";

const log = createLogger("queueRedis");

const PROCESSING_SUFFIX = ":processing";

export class RedisQueueClient {
  private client: Redis;
  private processingKey: string;

  constructor() {
    this.client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    this.processingKey = `${config.redisQueueKey}${PROCESSING_SUFFIX}`;
    this.client.on("error", (err) => {
      log.error("Redis connection error", { err: String(err) });
    });
  }

  async enqueueIntent(intent: IntentMessage) {
    await this.client.lpush(config.redisQueueKey, JSON.stringify(intent));
  }

  /**
   * Blocking pop from the main queue into a processing list where it can be
   * retried if not acknowledged. Uses a short timeout to allow graceful shutdown.
   */
  async fetchNextIntent(
    timeoutSeconds = 5,
  ): Promise<{ intent: IntentMessage | null; raw: string | null }> {
    const res = await this.client.brpoplpush(
      config.redisQueueKey,
      this.processingKey,
      timeoutSeconds,
    );
    if (!res) return { intent: null, raw: null };
    try {
      const intent = JSON.parse(res) as IntentMessage;
      return { intent, raw: res };
    } catch (err) {
      log.error("Failed to parse intent message", { err: String(err), raw: res });
      return { intent: null, raw: res };
    }
  }

  async ackIntent(raw: string) {
    const removed = await this.client.lrem(this.processingKey, 1, raw);
    if (removed === 0) {
      log.warn("Failed to ack intent (not found in processing list)");
    }
  }

  async moveToDeadLetter(raw: string) {
    await this.client.lpush(config.deadLetterKey, raw);
  }

  async close() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
