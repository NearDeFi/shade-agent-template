import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { config } from "../config";
import {
  getOrder,
  listUserOrders,
  markOrderFunded,
  Order,
  getOrderDescription,
} from "../state/orders";
import { getPollerStatus, checkOrders } from "../queue/orderPoller";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError, parseJsonBody } from "./errorHandling";
import {
  cancelOrder,
  createOrder,
  createOrderCancelSigningMessage,
  createOrderCreateSigningMessage,
  type CancelOrderRequest,
  type CreateOrderRequest,
} from "../services/ordersService";
import { intentValidator } from "../queue/flowCatalog";

const log = createLogger("orderRoutes");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

function readFundingKey(c: Context): string | undefined {
  const headerKey = c.req.header("x-order-funding-key");
  if (headerKey) return headerKey;

  const authorization = c.req.header("authorization");
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requireOrderFundingAuth(c: Context): void {
  if (!config.orderFundingApiKey) {
    throw new AppError(
      "service_unavailable",
      "Manual order funding endpoint is disabled",
    );
  }

  const providedKey = readFundingKey(c);
  if (!providedKey || !constantTimeEqual(providedKey, config.orderFundingApiKey)) {
    throw new AppError("unauthorized", "Invalid order funding key");
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/orders - Create a new conditional order
 *
 * Creates a limit, stop-loss, or take-profit order.
 * Returns the custody address where user should deposit funds to activate.
 */
app.post("/", async (c) => {
  if (!config.enableQueue) {
    throw new AppError("service_unavailable", "Queue consumer is disabled");
  }

  const payload = await parseJsonBody<CreateOrderRequest>(c);
  const result = await createOrder(payload, intentValidator);
  return c.json(result.body, result.status);
});

/**
 * GET /api/orders/:orderId - Get order details
 */
app.get("/:orderId", async (c) => {
  const orderId = c.req.param("orderId");

  const order = await getOrder(orderId);
  if (!order) {
    throw new AppError("not_found", `Order ${orderId} not found`);
  }

  return c.json({
    ...order,
    description: getOrderDescription(order),
  });
});

/**
 * GET /api/orders - List orders for a user
 *
 * Query params:
 * - userAddress: (required) User's address
 * - state: (optional) Filter by order state
 * - limit: (optional) Max results (default 50)
 */
app.get("/", async (c) => {
  const userAddress = c.req.query("userAddress");
  const state = c.req.query("state");
  const limit = parseInt(c.req.query("limit") || "50", 10);

  if (!userAddress) {
    throw new AppError("invalid_request", "userAddress query parameter is required");
  }

  const orders = await listUserOrders(userAddress, {
    state: state as Order["state"] | undefined,
    limit,
  });

  return c.json({
    count: orders.length,
    orders: orders.map((order) => ({
      ...order,
      description: getOrderDescription(order),
    })),
  });
});

/**
 * POST /api/orders/:orderId/cancel - Cancel an order
 *
 * Requires userSignature to authorize cancellation.
 * Optionally refunds remaining funds (default: true).
 */
app.post("/:orderId/cancel", async (c) => {
  if (!config.enableQueue) {
    throw new AppError("service_unavailable", "Queue consumer is disabled");
  }

  const orderId = c.req.param("orderId");
  const payload = await parseJsonBody<CancelOrderRequest>(c);
  const result = await cancelOrder(orderId, payload, intentValidator);
  return c.json(result.body, result.status);
});

/**
 * POST /api/orders/:orderId/fund - Mark order as funded (for deposit monitoring)
 *
 * Called when deposit is detected to activate the order.
 * In production, this should be called by a deposit monitor.
 */
app.post("/:orderId/fund", async (c) => {
  requireOrderFundingAuth(c);

  const orderId = c.req.param("orderId");

  const order = await getOrder(orderId);
  if (!order) {
    throw new AppError("not_found", `Order ${orderId} not found`);
  }

  if (order.state !== "pending") {
    return c.json({
      message: `Order is ${order.state}, not pending`,
      order: {
        ...order,
        description: getOrderDescription(order),
      },
    });
  }

  try {
    const updated = await markOrderFunded(orderId);

    log.info("Order marked as funded", {
      orderId,
      state: updated.state,
    });

    return c.json({
      message: "Order activated",
      order: {
        ...updated,
        description: getOrderDescription(updated),
      },
    });
  } catch (err) {
    throw new AppError("internal_error", "Failed to mark order as funded", {
      cause: err,
    });
  }
});

/**
 * GET /api/orders/status/poller - Get order poller status
 */
app.get("/status/poller", async (c) => {
  const status = await getPollerStatus();
  return c.json(status);
});

/**
 * POST /api/orders/status/check - Manually trigger order check
 *
 * For testing/debugging. Checks all active orders against current prices.
 */
app.post("/status/check", async (c) => {
  if (!config.enableQueue) {
    throw new AppError("service_unavailable", "Queue consumer is disabled");
  }

  const result = await checkOrders();
  return c.json(result);
});

export { createOrderCancelSigningMessage, createOrderCreateSigningMessage };
export default app;
