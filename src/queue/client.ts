import { RedisQueueClient } from "./redis";

// Shared queue client for HTTP routes/services that enqueue intents.
export const queueClient = new RedisQueueClient();
