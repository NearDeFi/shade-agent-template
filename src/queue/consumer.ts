import { setStatus } from "../state/status";
import { createDefaultFlowCatalog, createFlowContext, type FlowCatalog } from "../flows";
import { config } from "../config";
import { delay } from "../utils/common";
import { createLogger } from "../utils/logger";
import { RedisQueueClient } from "./redis";
import type { IntentMessage } from "./types";
import { createIntentProcessor, type IntentProcessor } from "./intentProcessor";
import { createIntentValidator, type IntentValidator } from "./validation";
import {
  type BackgroundTaskHandle,
  createLinkedAbortController,
  delayWithSignal,
} from "./runtime";

const log = createLogger("consumer");

interface StartQueueConsumerOptions {
  signal?: AbortSignal;
  pollTimeoutSeconds?: number;
  flowCatalog?: FlowCatalog;
  validateIntent?: IntentValidator;
  processor?: IntentProcessor;
}

/**
 * Starts the queue consumer with parallel processing support.
 * Uses a worker pool pattern to process multiple intents concurrently.
 */
export function startQueueConsumer(
  options: StartQueueConsumerOptions = {},
): BackgroundTaskHandle {
  const queue = new RedisQueueClient();
  const controller = createLinkedAbortController(options.signal);
  const signal = controller.signal;
  const concurrency = config.queueConcurrency;
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? 1;
  const inFlight = new Set<Promise<void>>();
  const recoveryIntervalMs = Math.max(1_000, config.redisRecoveryIntervalMs);
  let nextRecoveryAt = 0;

  const flowCatalog = options.flowCatalog ?? (
    process.env.NODE_ENV === "test"
      ? createDefaultFlowCatalog()
      : (() => {
          throw new Error(
            "Queue consumer requires an injected flow catalog. Initialize flows in startup composition.",
          );
        })()
  );
  const validateIntent = options.validateIntent ?? createIntentValidator(flowCatalog);
  const processor =
    options.processor ??
    createIntentProcessor({
      appConfig: config,
      flowCatalog,
      validateIntent,
      createFlowContext,
      setStatus,
      queue: {
        moveToDeadLetter: async (raw) => queue.moveToDeadLetter(raw),
      },
      delay,
      logger: log,
    });

  log.info(`Starting queue consumer with concurrency: ${concurrency}`);
  const loopPromise = (async () => {
    while (!signal.aborted) {
      const now = Date.now();
      if (now >= nextRecoveryAt) {
        nextRecoveryAt = now + recoveryIntervalMs;
        try {
          const recovered = await queue.reclaimStaleIntents(
            config.redisVisibilityMs,
            config.redisRecoveryBatchSize,
          );
          if (recovered > 0) {
            log.warn(`Recovered ${recovered} stale intents from processing queue`);
          }
        } catch (err) {
          log.error("Failed to recover stale processing intents", { err: String(err) });
        }
      }

      // Wait if we've hit max concurrency
      if (inFlight.size >= concurrency) {
        await delayWithSignal(100, signal);
        continue;
      }

      let next: Awaited<ReturnType<RedisQueueClient["fetchNextIntent"]>>;
      try {
        next = await queue.fetchNextIntent(pollTimeoutSeconds);
      } catch (err) {
        if (signal.aborted) break;
        log.error("Failed to fetch next intent from queue", { err: String(err) });
        await delayWithSignal(200, signal);
        continue;
      }
      if (signal.aborted) {
        break;
      }
      if (!next.intent || !next.raw) {
        if (next.raw) {
          log.warn("Received malformed intent message, acknowledging and skipping", {
            raw: next.raw.substring(0, 200),
          });
          try {
            await queue.ackIntent(next.raw);
          } catch (err) {
            log.error("Failed to acknowledge malformed intent message", {
              err: String(err),
            });
          }
        }
        continue;
      }

      const worker = processRawIntent(next.intent, next.raw, queue, processor)
        .catch((err) => {
          log.error("Uncaught worker error while processing intent", {
            err: String(err),
          });
        })
        .finally(() => {
          inFlight.delete(worker);
        });
      inFlight.add(worker);
    }
  })()
    .catch((err) => {
      log.error("Queue consumer crashed", { err: String(err) });
    })
    .finally(async () => {
      if (inFlight.size > 0) {
        await Promise.allSettled(Array.from(inFlight));
      }
      await queue.close();
      log.info("Queue consumer stopped");
    });

  return {
    stopped: loopPromise,
    stop: async () => {
      controller.abort();
      await loopPromise;
    },
  };
}

async function processRawIntent(
  intentMessage: IntentMessage,
  raw: string,
  queue: RedisQueueClient,
  processor: IntentProcessor,
): Promise<void> {
  let processed = false;
  try {
    await processor.processIntent(intentMessage, raw);
    processed = true;
  } finally {
    // Only acknowledge after the processor fully completes.
    // If processor throws (e.g., status persistence failure), keep the message
    // unacked to avoid silent loss.
    if (!processed) {
      return;
    }
    try {
      await queue.ackIntent(raw);
    } catch (err) {
      log.error("Failed to acknowledge intent", { err: String(err) });
    }
  }
}
