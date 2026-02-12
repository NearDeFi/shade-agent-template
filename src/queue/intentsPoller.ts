import { OneClickService } from "@defuse-protocol/one-click-sdk-typescript";
import { config } from "../config";
import {
  enqueueIntentWithStatus,
  getIntentsByState,
  setStatus,
  transitionStatus,
  type IntentStatus,
} from "../state/status";
import { runWithConcurrency } from "../utils/common";
import { createLogger } from "../utils/logger";
import { ensureIntentsApiBase } from "../infra/intentsApi";
import {
  type BackgroundTaskHandle,
  createLinkedAbortController,
  delayWithSignal,
} from "./runtime";
import type { IntentMetadata, ValidatedIntent } from "./types";

const log = createLogger("intentsPoller");

// How often to poll for swap status
const STATUS_POLL_INTERVAL_MS = 5_000;

interface IntentsSwapStatus {
  status: string;
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
  })().finally(() => {
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
  const pendingIntents = await getIntentsByState("awaiting_intents");

  if (pendingIntents.length === 0) {
    return;
  }

  log.info(`Checking ${pendingIntents.length} pending intents`);
  await runWithConcurrency(
    pendingIntents,
    config.intentsPollerConcurrency,
    async (intentStatus) => {
      try {
        await checkAndProcessIntent(intentStatus);
      } catch (err) {
        log.error(`Error checking intent ${intentStatus.intentId}`, { err: String(err) });
      }
    },
  );
}

export async function checkAndProcessIntent(intentStatus: { intentId: string } & IntentStatus) {
  const { intentId, depositAddress, depositMemo } = intentStatus;

  if (!depositAddress) {
    log.warn(`Intent ${intentId} missing depositAddress, skipping`);
    return;
  }

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
      await handleIntentsSuccess(intentStatus);
      break;

    case "refunded":
    case "failed":
      await setStatus(intentId, {
        state: "failed",
        error: `Intents swap ${swapStatus.status}`,
      });
      break;

    case "pending":
    case "processing":
      break;

    default:
      log.info(`Unknown status for ${intentId}: ${swapStatus.status}`);
  }
}

export async function handleIntentsSuccess(intentStatus: { intentId: string } & IntentStatus) {
  const {
    intentId,
    intentData,
    depositAddress,
    depositMemo,
  } = intentStatus;

  if (!intentData) {
    log.error(`Intent ${intentId} missing intentData`);
    await setStatus(intentId, {
      state: "failed",
      error: "Missing intent data after intents success",
    });
    return;
  }

  const claim = await transitionStatus(intentId, "awaiting_intents", {
    state: "processing",
    detail: "Intents swap completed, queueing execution",
    depositAddress,
    depositMemo,
    intentData,
  });
  if (!claim.updated) {
    log.info(`Skipping ${intentId}; state changed before success handling`, {
      currentState: claim.currentStatus?.state,
    });
    return;
  }

  const updatedIntent: ValidatedIntent = {
    ...intentData,
    metadata: intentData.metadata
      ? { ...intentData.metadata, intentsCompleted: true } as IntentMetadata
      : undefined,
  };

  try {
    await enqueueIntentWithStatus(updatedIntent, {
      state: "processing",
      detail: "Intents swap completed, executing Jupiter swap",
      depositAddress,
      depositMemo,
      intentData: updatedIntent,
    });
  } catch (err) {
    log.error(`Failed to re-enqueue ${intentId} after intents completion`, { err: String(err) });
    await setStatus(intentId, {
      state: "awaiting_intents",
      detail: "Retrying intents completion handoff",
      depositAddress,
      depositMemo,
      intentData,
      error: undefined,
    });
    return;
  }

  log.info(`Re-enqueued intent ${intentId} for post-intents execution`);
}
