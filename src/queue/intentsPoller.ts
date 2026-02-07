import { OneClickService } from "@defuse-protocol/one-click-sdk-typescript";
import { getIntentsByState, setStatus, IntentStatus } from "../state/status";
import { RedisQueueClient } from "./redis";
import { ValidatedIntent } from "./types";
import { createLogger } from "../utils/logger";
import { ensureIntentsApiBase } from "../infra/intentsApi";
import {
  type BackgroundTaskHandle,
  createLinkedAbortController,
  delayWithSignal,
} from "./runtime";

const log = createLogger("intentsPoller");

// Shared queue client to avoid creating a new Redis connection per re-enqueue
const sharedQueueClient = new RedisQueueClient();

// How often to poll for swap status
const STATUS_POLL_INTERVAL_MS = 5_000;

interface IntentsSwapStatus {
  status: string;
  // Add other fields as needed from the API response
}

/**
 * Polls the Defuse/Intents API for pending cross-chain swaps.
 * When a swap completes successfully, triggers the next step (e.g., Jupiter swap).
 */
interface StartIntentsPollerOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

export function startIntentsPoller(
  options: StartIntentsPollerOptions = {},
): BackgroundTaskHandle {
  ensureIntentsApiBase();
  const controller = createLinkedAbortController(options.signal);
  const signal = controller.signal;
  const pollIntervalMs = options.pollIntervalMs ?? STATUS_POLL_INTERVAL_MS;

  log.info("Starting intents status poller");

  const loopPromise = (async () => {
    while (!signal.aborted) {
      try {
        await pollPendingIntents();
      } catch (err) {
        log.error("Error polling intents", { err: String(err) });
      }

      await delayWithSignal(pollIntervalMs, signal);
    }
  })().finally(async () => {
    await sharedQueueClient.close();
    log.info("Intents status poller stopped");
  });

  return {
    stopped: loopPromise,
    stop: async () => {
      controller.abort();
      await loopPromise;
    },
  };
}

async function pollPendingIntents() {
  // Get all intents that are awaiting intents completion
  const pendingIntents = await getIntentsByState("awaiting_intents");

  if (pendingIntents.length === 0) {
    return;
  }

  log.info(`Checking ${pendingIntents.length} pending intents`);

  for (const intentStatus of pendingIntents) {
    try {
      await checkAndProcessIntent(intentStatus);
    } catch (err) {
      log.error(`Error checking intent ${intentStatus.intentId}`, { err: String(err) });
    }
  }
}

async function checkAndProcessIntent(intentStatus: { intentId: string } & IntentStatus) {
  const { intentId, depositAddress, depositMemo } = intentStatus;

  if (!depositAddress) {
    log.warn(`Intent ${intentId} missing depositAddress, skipping`);
    return;
  }

  // Query the Defuse API for swap status
  let swapStatus: IntentsSwapStatus;
  try {
    swapStatus = await OneClickService.getExecutionStatus(
      depositAddress,
      depositMemo,
    ) as IntentsSwapStatus;
  } catch (err) {
    log.error(`Failed to get status for ${intentId}`, { err: String(err) });
    return;
  }

  log.info(`Intent ${intentId} status: ${swapStatus.status}`);

  switch (swapStatus.status?.toLowerCase()) {
    case "success":
    case "completed":
      // Intents swap completed - trigger the next step
      await handleIntentsSuccess(intentStatus);
      break;

    case "refunded":
    case "failed":
      // Intents swap failed
      await setStatus(intentId, {
        state: "failed",
        error: `Intents swap ${swapStatus.status}`,
      });
      break;

    case "pending":
    case "processing":
      // Still in progress, continue polling
      break;

    default:
      log.info(`Unknown status for ${intentId}: ${swapStatus.status}`);
  }
}

async function handleIntentsSuccess(intentStatus: { intentId: string } & IntentStatus) {
  const { intentId, intentData } = intentStatus;

  if (!intentData) {
    log.error(`Intent ${intentId} missing intentData`);
    await setStatus(intentId, {
      state: "failed",
      error: "Missing intent data after intents success",
    });
    return;
  }

  log.info(`Intents swap completed for ${intentId}, queueing next step`);

  // Update status to indicate we're moving to the next step
  await setStatus(intentId, {
    state: "processing",
    detail: "Intents swap completed, executing Jupiter swap",
  });

  // Re-enqueue the intent for the consumer to process the Jupiter swap
  // Mark it so the consumer knows intents is already done
  const updatedIntent: ValidatedIntent = {
    ...intentData,
    metadata: {
      ...intentData.metadata,
      intentsCompleted: true,
    },
  };

  await sharedQueueClient.enqueueIntent(updatedIntent);

  log.info(`Re-enqueued intent ${intentId} for Jupiter swap`);
}
