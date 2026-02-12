import { RedisQueueClient } from "./redis";

export function createQueueClient(): RedisQueueClient {
  return new RedisQueueClient();
}

// Shared default queue client for HTTP routes/services.
export const queueClient = createQueueClient();
