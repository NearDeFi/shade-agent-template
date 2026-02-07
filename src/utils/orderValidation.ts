import type {
  IntentChain,
  OrderType,
  OrderSide,
  PriceCondition,
} from "../queue/types";

export interface OrderCreateValidationInput {
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
  userDestination?: string;
  expiresAt?: number;
  slippageTolerance?: number;
}

const VALID_ORDER_TYPES: OrderType[] = ["limit", "stop-loss", "take-profit"];
const VALID_ORDER_SIDES: OrderSide[] = ["buy", "sell"];
const VALID_PRICE_CONDITIONS: PriceCondition[] = ["above", "below"];

function requireField<T extends object>(
  payload: T,
  key: keyof T,
): void {
  if (!payload[key]) {
    throw new Error(`${String(key)} is required`);
  }
}

export function validateOrderCreateInput(
  payload: OrderCreateValidationInput,
  options?: { requireUserDestination?: boolean },
): void {
  const requiredFields: Array<keyof OrderCreateValidationInput> = [
    "orderId",
    "orderType",
    "side",
    "priceAsset",
    "quoteAsset",
    "triggerPrice",
    "priceCondition",
    "sourceChain",
    "sourceAsset",
    "amount",
    "destinationChain",
    "targetAsset",
  ];
  if (options?.requireUserDestination !== false) {
    requiredFields.push("userDestination");
  }

  for (const field of requiredFields) {
    requireField(payload, field);
  }

  if (payload.orderId.length < 8) {
    throw new Error("orderId must be at least 8 characters");
  }

  if (!VALID_ORDER_TYPES.includes(payload.orderType)) {
    throw new Error(`orderType must be one of: ${VALID_ORDER_TYPES.join(", ")}`);
  }

  if (!VALID_ORDER_SIDES.includes(payload.side)) {
    throw new Error(`side must be one of: ${VALID_ORDER_SIDES.join(", ")}`);
  }

  if (!VALID_PRICE_CONDITIONS.includes(payload.priceCondition)) {
    throw new Error(
      `priceCondition must be one of: ${VALID_PRICE_CONDITIONS.join(", ")}`,
    );
  }

  const triggerPrice = Number(payload.triggerPrice);
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    throw new Error(`Invalid triggerPrice: ${payload.triggerPrice}`);
  }

  let amount: bigint;
  try {
    amount = BigInt(payload.amount);
  } catch {
    throw new Error("amount must be positive");
  }
  if (amount <= 0n) {
    throw new Error("amount must be positive");
  }

  if (payload.expiresAt && payload.expiresAt < Date.now()) {
    throw new Error("expiresAt must be in the future");
  }

  if (payload.orderType === "limit") {
    if (payload.side === "buy" && payload.priceCondition !== "below") {
      throw new Error("Limit buy orders should trigger when price falls below target");
    }
    if (payload.side === "sell" && payload.priceCondition !== "above") {
      throw new Error("Limit sell orders should trigger when price rises above target");
    }
  }

  if (payload.orderType === "stop-loss") {
    if (payload.side !== "sell" || payload.priceCondition !== "below") {
      throw new Error("Stop-loss orders should sell when price falls below target");
    }
  }

  if (payload.orderType === "take-profit") {
    if (payload.side !== "sell" || payload.priceCondition !== "above") {
      throw new Error("Take-profit orders should sell when price rises above target");
    }
  }
}

export function requireSupportedOrderCustodyChain(
  sourceChain: IntentChain,
): "solana" | "near" {
  const custodyChain = sourceChain as "solana" | "near";
  if (custodyChain !== "solana" && custodyChain !== "near") {
    throw new Error(
      `Direct custody on ${sourceChain} not yet supported. Use Solana or NEAR as sourceChain.`,
    );
  }
  return custodyChain;
}
