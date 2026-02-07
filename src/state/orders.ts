import { config } from "../config";
import type { IntentChain, OrderType, OrderSide, PriceCondition } from "../queue/types";
import { redis } from "../infra/redis";
import { createLogger } from "../utils/logger";

const log = createLogger("orders");

// ─── Order State Types ──────────────────────────────────────────────────────────

export type OrderState =
  | "pending"     // Created, awaiting funding
  | "active"      // Funded, monitoring price
  | "triggered"   // Price condition met, executing
  | "executed"    // Successfully executed
  | "cancelled"   // User cancelled
  | "expired"     // Expiry time passed
  | "failed";     // Execution failed

const ALL_ORDER_STATES: OrderState[] = [
  "pending",
  "active",
  "triggered",
  "executed",
  "cancelled",
  "expired",
  "failed",
];

export interface Order {
  orderId: string;
  state: OrderState;

  // Order configuration
  orderType: OrderType;
  side: OrderSide;

  // Price monitoring
  priceAsset: string;
  quoteAsset: string;
  triggerPrice: string;
  priceCondition: PriceCondition;

  // Swap details
  sourceChain: IntentChain;
  sourceAsset: string;
  amount: string;
  destinationChain: IntentChain;
  targetAsset: string;

  // User info
  userAddress: string;
  userChain: IntentChain;

  // Agent custody
  agentAddress: string;
  agentChain: IntentChain;

  // Settings
  slippageTolerance: number;
  expiresAt?: number;

  // Timestamps
  createdAt: number;
  fundedAt?: number;
  triggeredAt?: number;
  executedAt?: number;
  cancelledAt?: number;

  // Execution details
  triggeredPrice?: string;
  /** Swap transaction hash (set as soon as the order swap is broadcast) */
  executionTxId?: string;
  outputAmount?: string;

  // Error tracking
  error?: string;

  // Intent tracking
  createIntentId?: string;
  executeIntentId?: string;

  // Permission contract tracking (for self-custodial orders)
  permissionOperationId?: string;
  permissionDerivationPath?: string;
}

// ─── Redis Setup ────────────────────────────────────────────────────────────────

const ORDER_PREFIX = "order:";
const ORDER_ACTIVE_SET = "orders:active"; // Set of active order IDs for polling
const ORDER_TRIGGERED_SET = "orders:triggered"; // Set of triggered order IDs for reconciliation
const ORDER_USER_SET_PREFIX = "orders:user:";
const ORDER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const ORDER_TRANSITION_MAX_RETRIES = 5;

function orderKey(orderId: string) {
  return `${ORDER_PREFIX}${orderId}`;
}

function orderUserSetKey(userAddress: string) {
  return `${ORDER_USER_SET_PREFIX}${userAddress}`;
}

function parseOrder(raw: string): Order | null {
  try {
    return JSON.parse(raw) as Order;
  } catch (err) {
    log.error("Failed to parse order from Redis", { err: String(err) });
    return null;
  }
}

async function getOrdersByIds(
  orderIds: string[],
  limit = Number.POSITIVE_INFINITY,
): Promise<{ orders: Order[]; staleIds: string[] }> {
  const orders: Order[] = [];
  const staleIds: string[] = [];

  for (let i = 0; i < orderIds.length && orders.length < limit; i += 100) {
    const batchIds = orderIds.slice(i, i + 100);
    const keys = batchIds.map((id) => orderKey(id));
    const values = await redis.mget(keys);

    for (let j = 0; j < values.length && orders.length < limit; j++) {
      const raw = values[j];
      const expectedOrderId = batchIds[j];
      if (!raw) {
        staleIds.push(expectedOrderId);
        continue;
      }

      const parsed = parseOrder(raw);
      if (!parsed) {
        staleIds.push(expectedOrderId);
        continue;
      }

      orders.push(parsed);
    }
  }

  return { orders, staleIds };
}

async function scanUserOrdersLegacy(
  userAddress: string,
  state: OrderState | undefined,
  limit: number,
): Promise<Order[]> {
  const matchPattern = `${ORDER_PREFIX}*`;
  let cursor = "0";
  const results: Order[] = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", matchPattern, "COUNT", 100);
    cursor = nextCursor;

    if (keys.length) {
      const values = await redis.mget(keys);
      for (const raw of values) {
        if (results.length >= limit) break;
        if (!raw) continue;

        const order = parseOrder(raw);
        if (!order) continue;
        if (order.userAddress !== userAddress) continue;
        if (state && order.state !== state) continue;
        results.push(order);
      }
    }
  } while (cursor !== "0" && results.length < limit);

  if (results.length > 0) {
    await redis.sadd(orderUserSetKey(userAddress), ...results.map((order) => order.orderId));
  }

  return results;
}

async function scanOrdersByStateLegacy(
  state: OrderState,
  limit: number,
): Promise<Order[]> {
  const matchPattern = `${ORDER_PREFIX}*`;
  let cursor = "0";
  const results: Order[] = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", matchPattern, "COUNT", 100);
    cursor = nextCursor;

    if (keys.length) {
      const values = await redis.mget(keys);
      for (const raw of values) {
        if (results.length >= limit) break;
        if (!raw) continue;

        const order = parseOrder(raw);
        if (!order || order.state !== state) continue;
        results.push(order);
      }
    }
  } while (cursor !== "0" && results.length < limit);

  const targetSet = state === "triggered" ? ORDER_TRIGGERED_SET : ORDER_ACTIVE_SET;
  if (results.length > 0) {
    await redis.sadd(targetSet, ...results.map((order) => order.orderId));
  }

  return results;
}

// ─── CRUD Operations ────────────────────────────────────────────────────────────

/**
 * Create a new order
 */
export async function createOrder(order: Order): Promise<void> {
  const key = orderKey(order.orderId);
  const created = await redis.set(key, JSON.stringify(order), "EX", ORDER_TTL_SECONDS, "NX");
  if (created !== "OK") {
    throw new Error(`Order ${order.orderId} already exists`);
  }

  const pipeline = redis.pipeline();
  pipeline.sadd(orderUserSetKey(order.userAddress), order.orderId);

  // Add to active set if active
  if (order.state === "active") {
    pipeline.sadd(ORDER_ACTIVE_SET, order.orderId);
  }
  if (order.state === "triggered") {
    pipeline.sadd(ORDER_TRIGGERED_SET, order.orderId);
  }

  await pipeline.exec();
}

/**
 * Get an order by ID
 */
export async function getOrder(orderId: string): Promise<Order | null> {
  const raw = await redis.get(orderKey(orderId));
  if (!raw) return null;
  return parseOrder(raw);
}

/**
 * Update an order
 */
export async function updateOrder(
  orderId: string,
  updates: Partial<Order>,
): Promise<Order> {
  const existing = await getOrder(orderId);
  if (!existing) {
    throw new Error(`Order ${orderId} not found`);
  }

  const updated: Order = { ...existing, ...updates };

  const pipeline = redis.pipeline();
  pipeline.set(orderKey(orderId), JSON.stringify(updated), "EX", ORDER_TTL_SECONDS);
  pipeline.sadd(orderUserSetKey(updated.userAddress), orderId);

  // Update active set membership
  if (updated.state === "active") {
    pipeline.sadd(ORDER_ACTIVE_SET, orderId);
  } else {
    pipeline.srem(ORDER_ACTIVE_SET, orderId);
  }
  if (updated.state === "triggered") {
    pipeline.sadd(ORDER_TRIGGERED_SET, orderId);
  } else {
    pipeline.srem(ORDER_TRIGGERED_SET, orderId);
  }

  if (updated.userAddress !== existing.userAddress) {
    pipeline.srem(orderUserSetKey(existing.userAddress), orderId);
  }

  await pipeline.exec();
  return updated;
}

/**
 * Update order state
 */
export async function setOrderState(
  orderId: string,
  state: OrderState,
  additionalFields?: Partial<Order>,
): Promise<Order> {
  const transition = await transitionOrderState(
    orderId,
    ALL_ORDER_STATES,
    state,
    additionalFields,
  );
  if (transition.updated && transition.order) {
    return transition.order;
  }
  if (!transition.order) {
    throw new Error(`Order ${orderId} not found`);
  }
  throw new Error(
    `Failed to set order ${orderId} to ${state}; current state is ${transition.currentState ?? "unknown"}`,
  );
}

function buildStateUpdates(
  state: OrderState,
  additionalFields?: Partial<Order>,
): Partial<Order> {
  const updates: Partial<Order> = { state, ...additionalFields };

  if (state === "triggered") {
    updates.triggeredAt = Date.now();
  } else if (state === "executed") {
    updates.executedAt = Date.now();
  } else if (state === "cancelled") {
    updates.cancelledAt = Date.now();
  }

  return updates;
}

/**
 * Atomically transition order state if it currently matches the expected state(s).
 * Uses Redis WATCH/MULTI to avoid duplicate triggers in concurrent pollers.
 */
export async function transitionOrderState(
  orderId: string,
  expectedState: OrderState | OrderState[],
  nextState: OrderState,
  additionalFields?: Partial<Order>,
): Promise<{ updated: boolean; order: Order | null; currentState: OrderState | null }> {
  const expected = Array.isArray(expectedState) ? expectedState : [expectedState];
  const key = orderKey(orderId);

  for (let attempt = 0; attempt < ORDER_TRANSITION_MAX_RETRIES; attempt++) {
    await redis.watch(key);
    const raw = await redis.get(key);
    if (!raw) {
      await redis.unwatch();
      return { updated: false, order: null, currentState: null };
    }

    let existing: Order;
    try {
      existing = JSON.parse(raw) as Order;
    } catch (err) {
      log.error("Failed to parse order from Redis", { err: String(err) });
      await redis.unwatch();
      return { updated: false, order: null, currentState: null };
    }

    if (!expected.includes(existing.state)) {
      await redis.unwatch();
      return {
        updated: false,
        order: existing,
        currentState: existing.state,
      };
    }

    const updated: Order = {
      ...existing,
      ...buildStateUpdates(nextState, additionalFields),
    };

    const tx = redis.multi();
    tx.set(key, JSON.stringify(updated), "EX", ORDER_TTL_SECONDS);
    if (updated.state === "active") {
      tx.sadd(ORDER_ACTIVE_SET, orderId);
    } else {
      tx.srem(ORDER_ACTIVE_SET, orderId);
    }
    if (updated.state === "triggered") {
      tx.sadd(ORDER_TRIGGERED_SET, orderId);
    } else {
      tx.srem(ORDER_TRIGGERED_SET, orderId);
    }

    const execResult = await tx.exec();
    if (execResult) {
      return { updated: true, order: updated, currentState: updated.state };
    }
    // Watched key changed before EXEC; retry.
  }

  const latest = await getOrder(orderId);
  return {
    updated: false,
    order: latest,
    currentState: latest?.state ?? null,
  };
}

/**
 * Mark order as funded and active
 */
export async function markOrderFunded(orderId: string): Promise<Order> {
  const transition = await transitionOrderState(
    orderId,
    "pending",
    "active",
    { fundedAt: Date.now() },
  );
  if (transition.updated && transition.order) {
    return transition.order;
  }
  if (!transition.order) {
    throw new Error(`Order ${orderId} not found`);
  }
  if (transition.currentState === "active") {
    return transition.order;
  }
  throw new Error(
    `Cannot mark order ${orderId} as funded from state ${transition.currentState ?? "unknown"}`,
  );
}

/**
 * Mark order as triggered (price condition met)
 */
export async function markOrderTriggered(
  orderId: string,
  triggeredPrice: string,
): Promise<Order> {
  const transition = await transitionOrderState(
    orderId,
    "active",
    "triggered",
    { triggeredPrice },
  );
  if (transition.updated && transition.order) {
    return transition.order;
  }
  if (!transition.order) {
    throw new Error(`Order ${orderId} not found`);
  }
  if (transition.currentState === "triggered") {
    return transition.order;
  }
  throw new Error(
    `Cannot mark order ${orderId} as triggered from state ${transition.currentState ?? "unknown"}`,
  );
}

/**
 * Mark order as executed
 */
export async function markOrderExecuted(
  orderId: string,
  executionTxId: string,
  outputAmount?: string,
): Promise<Order> {
  const transition = await transitionOrderState(
    orderId,
    "triggered",
    "executed",
    { executionTxId, outputAmount },
  );
  if (transition.updated && transition.order) {
    return transition.order;
  }
  if (!transition.order) {
    throw new Error(`Order ${orderId} not found`);
  }
  if (transition.currentState === "executed") {
    return transition.order;
  }
  throw new Error(
    `Cannot mark order ${orderId} as executed from state ${transition.currentState ?? "unknown"}`,
  );
}

/**
 * Mark order as failed
 */
export async function markOrderFailed(
  orderId: string,
  error: string,
): Promise<Order> {
  const transition = await transitionOrderState(
    orderId,
    ["pending", "active", "triggered"],
    "failed",
    { error },
  );
  if (transition.updated && transition.order) {
    return transition.order;
  }
  if (!transition.order) {
    throw new Error(`Order ${orderId} not found`);
  }
  if (transition.currentState === "failed") {
    return transition.order;
  }
  throw new Error(
    `Cannot mark order ${orderId} as failed from state ${transition.currentState ?? "unknown"}`,
  );
}

// ─── Query Operations ───────────────────────────────────────────────────────────

/**
 * Get all active order IDs
 */
export async function getActiveOrderIds(): Promise<string[]> {
  return redis.smembers(ORDER_ACTIVE_SET);
}

/**
 * Get all active orders
 */
export async function getActiveOrders(): Promise<Order[]> {
  const orderIds = await getActiveOrderIds();
  if (orderIds.length === 0) {
    return scanOrdersByStateLegacy("active", 200);
  }

  const { orders, staleIds } = await getOrdersByIds(orderIds);
  const nonActiveIds = orders
    .filter((order) => order.state !== "active")
    .map((order) => order.orderId);

  const staleActiveIds = [...staleIds, ...nonActiveIds];
  if (staleActiveIds.length > 0) {
    await redis.srem(ORDER_ACTIVE_SET, ...staleActiveIds);
  }

  return orders.filter((order) => order.state === "active");
}

export async function getTriggeredOrderIds(): Promise<string[]> {
  return redis.smembers(ORDER_TRIGGERED_SET);
}

export async function getTriggeredOrders(limit = 200): Promise<Order[]> {
  const orderIds = await getTriggeredOrderIds();
  if (orderIds.length === 0) {
    return scanOrdersByStateLegacy("triggered", limit);
  }

  const { orders, staleIds } = await getOrdersByIds(orderIds, limit);
  const nonTriggeredIds = orders
    .filter((order) => order.state !== "triggered")
    .map((order) => order.orderId);

  const staleTriggeredIds = [...staleIds, ...nonTriggeredIds];
  if (staleTriggeredIds.length > 0) {
    await redis.srem(ORDER_TRIGGERED_SET, ...staleTriggeredIds);
  }

  return orders.filter((order) => order.state === "triggered");
}

/**
 * Get active orders grouped by price pair for efficient price fetching
 */
export async function getActiveOrdersByPricePair(): Promise<Map<string, Order[]>> {
  const orders = await getActiveOrders();
  const grouped = new Map<string, Order[]>();

  for (const order of orders) {
    const key = `${order.priceAsset}:${order.quoteAsset}`;
    const existing = grouped.get(key) || [];
    existing.push(order);
    grouped.set(key, existing);
  }

  return grouped;
}

/**
 * Get orders that have expired
 */
export async function getExpiredOrders(): Promise<Order[]> {
  const now = Date.now();
  const orders = await getActiveOrders();

  return orders.filter((order) => {
    if (!order.expiresAt) return false;
    return order.expiresAt <= now;
  });
}

/**
 * List orders for a user
 */
export async function listUserOrders(
  userAddress: string,
  options: { state?: OrderState; limit?: number } = {},
): Promise<Order[]> {
  const { state, limit = 50 } = options;
  const orderIds = await redis.smembers(orderUserSetKey(userAddress));
  if (orderIds.length === 0) {
    const legacyOrders = await scanUserOrdersLegacy(userAddress, state, limit);
    return legacyOrders.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  const { orders, staleIds } = await getOrdersByIds(orderIds);

  const mismatchedUserIds: string[] = [];
  const filtered = orders.filter((order) => {
    if (order.userAddress !== userAddress) {
      mismatchedUserIds.push(order.orderId);
      return false;
    }
    if (state && order.state !== state) return false;
    return true;
  });

  const staleUserIds = [...staleIds, ...mismatchedUserIds];
  if (staleUserIds.length > 0) {
    await redis.srem(orderUserSetKey(userAddress), ...staleUserIds);
  }

  return filtered
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * Check if an order should trigger based on current price
 */
export function shouldTrigger(order: Order, currentPrice: number): boolean {
  const triggerPrice = parseFloat(order.triggerPrice);

  if (order.priceCondition === "above") {
    return currentPrice >= triggerPrice;
  } else {
    return currentPrice <= triggerPrice;
  }
}

/**
 * Get human-readable order description
 */
export function getOrderDescription(order: Order): string {
  const action = order.side === "buy" ? "Buy" : "Sell";
  const condition = order.priceCondition === "above" ? "rises above" : "falls below";

  return `${order.orderType}: ${action} when ${order.priceAsset} ${condition} ${order.triggerPrice} ${order.quoteAsset}`;
}
