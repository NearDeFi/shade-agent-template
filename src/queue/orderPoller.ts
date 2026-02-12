/**
 * Order Poller
 * Monitors prices and triggers conditional orders when price conditions are met.
 */

import { config } from "../config";
import {
  getActiveOrdersByPricePair,
  getExpiredOrders,
  getTriggeredOrders,
  shouldTrigger,
  setOrderState,
  transitionOrderState,
  Order,
  getOrderDescription,
} from "../state/orders";
import { getPrice, formatPrice } from "../utils/priceFeed";
import { runWithConcurrency } from "../utils/common";
import { RedisQueueClient } from "./redis";
import { ValidatedIntent, OrderExecuteMetadata } from "./types";
import { createLogger } from "../utils/logger";
import {
  type BackgroundTaskHandle,
  createLinkedAbortController,
  delayWithSignal,
} from "./runtime";

const log = createLogger("orderPoller");

// How often to check prices
const ORDER_POLL_INTERVAL_MS = 15_000; // 15 seconds

// Shared queue client to avoid creating a new Redis connection per poll cycle
const sharedQueueClient = new RedisQueueClient();

/**
 * Start the order price monitoring poller
 */
interface StartOrderPollerOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

export function startOrderPoller(
  options: StartOrderPollerOptions = {},
): BackgroundTaskHandle {
  if (!config.enableQueue) {
    log.info("Queue disabled, not starting order poller");
    return {
      stopped: Promise.resolve(),
      stop: async () => {},
    };
  }
  const controller = createLinkedAbortController(options.signal);
  const signal = controller.signal;
  const pollIntervalMs = options.pollIntervalMs ?? ORDER_POLL_INTERVAL_MS;

  log.info("Starting conditional order poller");
  log.info(`Poll interval: ${pollIntervalMs}ms`);

  const loopPromise = (async () => {
    while (!signal.aborted) {
      try {
        await pollOrders();
      } catch (err) {
        log.error("Error polling orders", { err: String(err) });
      }

      await delayWithSignal(pollIntervalMs, signal);
    }
  })().finally(async () => {
    await sharedQueueClient.close();
    log.info("Order poller stopped");
  });

  return {
    stopped: loopPromise,
    stop: async () => {
      controller.abort();
      await loopPromise;
    },
  };
}

/**
 * Poll all active orders, check prices, trigger if conditions met
 */
async function pollOrders() {
  // Get orders grouped by price pair for efficient fetching
  const ordersByPair = await getActiveOrdersByPricePair();

  if (ordersByPair.size === 0) {
    return;
  }

  log.info(`Checking ${ordersByPair.size} price pairs`);

  let triggeredCount = 0;

  const pairEntries = Array.from(ordersByPair.entries());
  await runWithConcurrency(
    pairEntries,
    config.orderPollerPairConcurrency,
    async ([pairKey, orders]) => {
      const [priceAsset, quoteAsset] = pairKey.split(":");

      try {
        const priceData = await getPrice(priceAsset, quoteAsset);
        const currentPrice = priceData.price;

        log.info(`${priceAsset}/${quoteAsset}: ${formatPrice(currentPrice)} (${orders.length} orders)`);

        for (const order of orders) {
          if (!shouldTrigger(order, currentPrice)) continue;

          log.info(`TRIGGERED: ${getOrderDescription(order)}`);
          log.info(`Current: ${formatPrice(currentPrice)}, Trigger: ${order.triggerPrice}`);
          const enqueued = await triggerOrder(order, formatPrice(currentPrice));
          if (enqueued) {
            triggeredCount++;
          }
        }
      } catch (error) {
        log.error(`Error fetching price for ${pairKey}`, { err: String(error) });
      }
    },
  );

  // Handle expired orders
  await handleExpiredOrders();
  await reconcileStuckTriggeredOrders();

  if (triggeredCount > 0) {
    log.info(`Triggered ${triggeredCount} orders`);
  }
}

/**
 * Trigger an order for execution
 */
async function triggerOrder(
  order: Order,
  triggeredPrice: string,
): Promise<boolean> {
  // Create execution intent
  const metadata: OrderExecuteMetadata = {
    action: "order-execute",
    orderId: order.orderId,
    triggeredPrice,
  };

  const intent: ValidatedIntent = {
    intentId: `order-exec-${order.orderId}-${Date.now()}`,
    sourceChain: order.sourceChain,
    sourceAsset: order.sourceAsset,
    sourceAmount: order.amount,
    destinationChain: order.destinationChain,
    finalAsset: order.targetAsset,
    userDestination: order.userAddress,
    agentDestination: order.agentAddress,
    slippageBps: order.slippageTolerance,
    metadata,
  };

  // Atomically claim this order for trigger to prevent duplicate enqueue.
  const claimed = await transitionOrderState(
    order.orderId,
    "active",
    "triggered",
    { triggeredPrice },
  );
  if (!claimed.updated) {
    log.info(`Skipping trigger for ${order.orderId}; state is ${claimed.currentState ?? "unknown"}`);
    return false;
  }

  try {
    // Enqueue for execution
    await sharedQueueClient.enqueueIntent(intent);
  } catch (err) {
    // Revert to active so poller can retry trigger on next cycle.
    await transitionOrderState(
      order.orderId,
      "triggered",
      "active",
      {
        triggeredPrice: undefined,
        triggeredAt: undefined,
      },
    );
    throw err;
  }

  log.info(`Enqueued order execution: ${intent.intentId}`);
  return true;
}

/**
 * Handle orders that have expired
 */
async function handleExpiredOrders() {
  const expiredOrders = await getExpiredOrders();

  for (const order of expiredOrders) {
    log.info(`Order ${order.orderId} expired`);
    await setOrderState(order.orderId, "expired");
    // Note: Funds stay in custody - user must call order-cancel to get refund
  }
}

async function reconcileStuckTriggeredOrders() {
  const timeoutMs = config.orderTriggeredTimeoutMs;
  if (timeoutMs <= 0) return;

  const triggeredOrders = await getTriggeredOrders();
  if (triggeredOrders.length === 0) return;

  const now = Date.now();
  for (const order of triggeredOrders) {
    const triggeredAt = order.triggeredAt ?? 0;
    if (triggeredAt <= 0) continue;
    if (now - triggeredAt < timeoutMs) continue;

    if (order.executionTxId) {
      const settled = await transitionOrderState(order.orderId, "triggered", "executed", {
        executionTxId: order.executionTxId,
      });
      if (settled.updated) {
        log.warn(`Reconciled stale triggered order as executed`, {
          orderId: order.orderId,
          txId: order.executionTxId,
          ageMs: now - triggeredAt,
        });
      }
      continue;
    }

    const reset = await transitionOrderState(order.orderId, "triggered", "active", {
      triggeredPrice: undefined,
      triggeredAt: undefined,
    });
    if (reset.updated) {
      log.warn(`Reconciled stale triggered order back to active`, {
        orderId: order.orderId,
        ageMs: now - triggeredAt,
      });
    }
  }
}

/**
 * Check orders once (for testing or manual trigger)
 */
export async function checkOrders(): Promise<{
  checked: number;
  triggered: number;
}> {
  const ordersByPair = await getActiveOrdersByPricePair();
  let checked = 0;
  let triggered = 0;

  const pairEntries = Array.from(ordersByPair.entries());
  await runWithConcurrency(
    pairEntries,
    config.orderPollerPairConcurrency,
    async ([pairKey, orders]) => {
      const [priceAsset, quoteAsset] = pairKey.split(":");

      try {
        const priceData = await getPrice(priceAsset, quoteAsset);

        for (const order of orders) {
          checked++;
          if (!shouldTrigger(order, priceData.price)) continue;
          const enqueued = await triggerOrder(order, formatPrice(priceData.price));
          if (enqueued) {
            triggered++;
          }
        }
      } catch (error) {
        log.error(`Error checking ${pairKey}`, { err: String(error) });
      }
    },
  );

  await reconcileStuckTriggeredOrders();

  return { checked, triggered };
}

/**
 * Get price monitoring status
 */
export async function getPollerStatus(): Promise<{
  activePairs: number;
  activeOrders: number;
  pairs: Array<{ pair: string; orderCount: number }>;
}> {
  const ordersByPair = await getActiveOrdersByPricePair();

  const pairs = Array.from(ordersByPair.entries()).map(([pair, orders]) => ({
    pair,
    orderCount: orders.length,
  }));

  return {
    activePairs: ordersByPair.size,
    activeOrders: pairs.reduce((sum, p) => sum + p.orderCount, 0),
    pairs,
  };
}
