import crypto from "crypto";
import { address } from "@solana/kit";
import type { IntentValidator } from "../queue/validation";
import type {
  IntentChain,
  IntentMessage,
  OrderCancelMetadata,
  OrderCreateMetadata,
  OrderSide,
  OrderType,
  PriceCondition,
  UserSignature,
} from "../queue/types";
import { enqueueIntentWithStatus } from "../state/status";
import { deriveOrderAgentAddress } from "../flows/orderCreate";
import { getOrder } from "../state/orders";
import { isNearSignature, verifyNearSignature } from "../utils/nearSignature";
import { verifySolanaSignature } from "../utils/solanaSignature";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import {
  requireSupportedOrderCustodyChain,
  validateOrderCreateInput,
} from "../utils/orderValidation";
import { intentValidator as sharedIntentValidator } from "../queue/flowCatalog";

const log = createLogger("orders/service");

interface OrderServiceDeps {
  enqueueIntentWithStatusFn?: typeof enqueueIntentWithStatus;
}

export interface CreateOrderRequest {
  orderId: string;
  orderType: OrderType;
  side: OrderSide;
  priceAsset: string;
  quoteAsset: string;
  triggerPrice: string;
  priceCondition: PriceCondition;
  sourceChain: IntentChain;
  sourceAsset: string;
  amount: string;
  destinationChain: IntentChain;
  targetAsset: string;
  userDestination: string;
  expiresAt?: number;
  slippageTolerance?: number;
  userSignature?: UserSignature;
}

export interface CancelOrderRequest {
  orderId: string;
  userDestination: string;
  refundFunds?: boolean;
  userSignature: UserSignature;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const serialized = keys
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",");
  return `{${serialized}}`;
}

function sha256Hex(message: string): string {
  return crypto.createHash("sha256").update(message).digest("hex");
}

export function createOrderCreateSigningMessage(payload: CreateOrderRequest): string {
  const canonicalPayload = {
    operation: "order-create-v1",
    orderId: payload.orderId,
    orderType: payload.orderType,
    side: payload.side,
    priceAsset: payload.priceAsset,
    quoteAsset: payload.quoteAsset,
    triggerPrice: payload.triggerPrice,
    priceCondition: payload.priceCondition,
    sourceChain: payload.sourceChain,
    sourceAsset: payload.sourceAsset,
    amount: payload.amount,
    destinationChain: payload.destinationChain,
    targetAsset: payload.targetAsset,
    userDestination: payload.userDestination,
    expiresAt: payload.expiresAt ?? null,
    slippageTolerance: payload.slippageTolerance ?? null,
  };
  return sha256Hex(stableStringify(canonicalPayload));
}

export function createOrderCancelSigningMessage(
  orderId: string,
  userDestination: string,
  refundFunds: boolean,
): string {
  const canonicalPayload = {
    operation: "order-cancel-v1",
    orderId,
    userDestination,
    refundFunds,
  };
  return sha256Hex(stableStringify(canonicalPayload));
}

function verifySignature(
  sig: UserSignature | undefined,
  expectedMessage: string,
  expectedUserDestination?: string,
): { valid: boolean; error?: string } {
  if (!sig) return { valid: false, error: "userSignature is required" };

  if (sig.message !== expectedMessage) {
    return { valid: false, error: "Signed message does not match request payload" };
  }

  if (isNearSignature(sig)) {
    if (!verifyNearSignature(sig)) {
      return { valid: false, error: "Invalid NEAR signature" };
    }
    return { valid: true };
  }

  if (expectedUserDestination) {
    try {
      // Normalize addresses via address() — validates format and returns canonical string
      const expectedSigner = address(expectedUserDestination);
      const actualSigner = address(sig.publicKey);
      if (expectedSigner !== actualSigner) {
        return { valid: false, error: "Solana signer does not match userDestination" };
      }
    } catch {
      return {
        valid: false,
        error: "Solana signatures require userDestination to be a valid Solana public key",
      };
    }
  }

  const valid = verifySolanaSignature({
    message: sig.message,
    signature: sig.signature,
    publicKey: sig.publicKey,
  });
  if (!valid) {
    return { valid: false, error: "Invalid Solana signature" };
  }
  return { valid: true };
}

function validateCreatePayload(payload: CreateOrderRequest) {
  try {
    validateOrderCreateInput(payload);
  } catch (err) {
    throw new AppError("invalid_request", (err as Error).message, { cause: err });
  }
}

function validateCreateSignature(payload: CreateOrderRequest) {
  if (!payload.userSignature) {
    return;
  }

  const expectedMessage = createOrderCreateSigningMessage(payload);
  const signatureResult = verifySignature(
    payload.userSignature,
    expectedMessage,
    payload.userDestination,
  );
  if (!signatureResult.valid) {
    throw new AppError(
      "forbidden",
      `Invalid userSignature: ${signatureResult.error}`,
    );
  }

  log.info("Signature verified", {
    orderId: payload.orderId,
    publicKey: payload.userSignature.publicKey,
  });
}

export async function createOrder(
  payload: CreateOrderRequest,
  validateIntentFn: IntentValidator = sharedIntentValidator,
  deps: OrderServiceDeps = {},
) {
  validateCreatePayload(payload);
  validateCreateSignature(payload);

  let custodyChain: "solana" | "near";
  try {
    custodyChain = requireSupportedOrderCustodyChain(payload.sourceChain);
  } catch (err) {
    throw new AppError("invalid_request", (err as Error).message, { cause: err });
  }
  let custodyAddress: string;
  try {
    custodyAddress = await deriveOrderAgentAddress(payload.orderId, custodyChain);
  } catch (err) {
    log.error("Failed to derive custody address", { err: String(err) });
    throw new AppError("internal_error", "Failed to derive custody address", { cause: err });
  }

  const metadata: OrderCreateMetadata = {
    action: "order-create",
    orderId: payload.orderId,
    orderType: payload.orderType,
    side: payload.side,
    priceAsset: payload.priceAsset,
    quoteAsset: payload.quoteAsset,
    triggerPrice: payload.triggerPrice,
    priceCondition: payload.priceCondition,
    sourceChain: payload.sourceChain,
    sourceAsset: payload.sourceAsset,
    amount: payload.amount,
    destinationChain: payload.destinationChain,
    targetAsset: payload.targetAsset,
    expiresAt: payload.expiresAt,
    slippageTolerance: payload.slippageTolerance,
  };

  const intentId = `order-create-${payload.orderId}-${Date.now()}`;
  const intentMessage: IntentMessage = {
    intentId,
    sourceChain: payload.sourceChain,
    sourceAsset: payload.sourceAsset,
    sourceAmount: payload.amount,
    destinationChain: payload.destinationChain,
    finalAsset: payload.targetAsset,
    userDestination: payload.userDestination,
    agentDestination: custodyAddress,
    slippageBps: payload.slippageTolerance,
    metadata,
    userSignature: payload.userSignature,
  };

  try {
    const validatedIntent = validateIntentFn(intentMessage);
    await (deps.enqueueIntentWithStatusFn ?? enqueueIntentWithStatus)(
      validatedIntent,
      { state: "pending" },
    );
  } catch (err) {
    log.error("Failed to enqueue order creation", { err: String(err) });
    throw new AppError("internal_error", (err as Error).message, { cause: err });
  }

  log.info("Order creation intent enqueued", {
    orderId: payload.orderId,
    intentId,
    custodyAddress,
    orderType: payload.orderType,
  });

  return {
    status: 202 as const,
    body: {
      intentId,
      orderId: payload.orderId,
      state: "pending" as const,
      custodyAddress,
      custodyChain,
      message: `Deposit ${payload.amount} ${payload.sourceAsset} to ${custodyAddress} to activate the order`,
      order: {
        orderType: payload.orderType,
        side: payload.side,
        priceAsset: payload.priceAsset,
        quoteAsset: payload.quoteAsset,
        triggerPrice: payload.triggerPrice,
        priceCondition: payload.priceCondition,
      },
    },
  };
}

export async function cancelOrder(
  orderId: string,
  payload: CancelOrderRequest,
  validateIntentFn: IntentValidator = sharedIntentValidator,
  deps: OrderServiceDeps = {},
) {
  if (!payload.userDestination) {
    throw new AppError("invalid_request", "userDestination is required");
  }
  if (!payload.userSignature) {
    throw new AppError("forbidden", "userSignature is required for cancellation");
  }

  if (payload.orderId && payload.orderId !== orderId) {
    throw new AppError("invalid_request", "Payload orderId does not match route orderId");
  }

  const order = await getOrder(orderId);
  if (!order) {
    throw new AppError("not_found", `Order ${orderId} not found`);
  }

  if (order.userAddress !== payload.userDestination) {
    throw new AppError("forbidden", "Only the order owner can cancel this order");
  }

  const refundFunds = payload.refundFunds !== false;
  const expectedCancelMessage = createOrderCancelSigningMessage(
    orderId,
    payload.userDestination,
    refundFunds,
  );
  const signatureResult = verifySignature(
    payload.userSignature,
    expectedCancelMessage,
    payload.userDestination,
  );
  if (!signatureResult.valid) {
    throw new AppError(
      "forbidden",
      `Invalid userSignature: ${signatureResult.error}`,
    );
  }

  if (order.state === "cancelled") {
    return {
      status: 200 as const,
      body: { message: "Order already cancelled", order },
    };
  }
  if (order.state === "executed") {
    throw new AppError("invalid_request", "Cannot cancel an executed order");
  }

  const metadata: OrderCancelMetadata = {
    action: "order-cancel",
    orderId,
    refundFunds,
  };

  const intentId = `order-cancel-${orderId}-${Date.now()}`;
  const intentMessage: IntentMessage = {
    intentId,
    sourceChain: order.sourceChain,
    sourceAsset: order.sourceAsset,
    sourceAmount: order.amount,
    destinationChain: order.agentChain,
    finalAsset: order.sourceAsset,
    userDestination: payload.userDestination,
    agentDestination: order.agentAddress,
    metadata,
    userSignature: payload.userSignature,
  };

  try {
    const validatedIntent = validateIntentFn(intentMessage);
    await (deps.enqueueIntentWithStatusFn ?? enqueueIntentWithStatus)(
      validatedIntent,
      { state: "pending" },
    );
  } catch (err) {
    log.error("Failed to enqueue order cancellation", { err: String(err) });
    throw new AppError("internal_error", (err as Error).message, { cause: err });
  }

  log.info("Order cancellation intent enqueued", {
    orderId,
    intentId,
    refundFunds: metadata.refundFunds,
  });

  return {
    status: 202 as const,
    body: {
      intentId,
      orderId,
      state: "pending" as const,
      message: metadata.refundFunds
        ? "Order cancellation initiated, funds will be refunded"
        : "Order cancellation initiated",
    },
  };
}
