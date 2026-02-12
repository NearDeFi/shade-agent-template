import type { IntentState } from "./status";
import type { OrderState } from "./orders";

/**
 * Valid state transitions for intent processing.
 * Terminal states (succeeded, failed) have no outbound transitions.
 */
export const VALID_INTENT_TRANSITIONS: Record<IntentState, IntentState[]> = {
  pending: ["processing", "failed"],
  processing: ["awaiting_deposit", "awaiting_intents", "awaiting_user_tx", "succeeded", "failed"],
  awaiting_deposit: ["processing", "failed"],
  awaiting_intents: ["processing", "failed"],
  awaiting_user_tx: ["processing", "failed"],
  succeeded: [],
  failed: [],
};

/**
 * Valid state transitions for conditional orders.
 */
export const VALID_ORDER_TRANSITIONS: Record<OrderState, OrderState[]> = {
  pending: ["active", "cancelled", "failed"],
  active: ["triggered", "cancelled", "expired", "failed"],
  triggered: ["executed", "failed"],
  executed: [],
  cancelled: [],
  expired: [],
  failed: [],
};

/**
 * Assert that a state transition is valid according to the given matrix.
 * Throws if the transition is not allowed.
 */
export function assertValidTransition<S extends string>(
  from: S,
  to: S,
  matrix: Record<S, S[]>,
  label: string,
): void {
  const allowed = matrix[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(
      `Invalid ${label} transition: ${from} → ${to}. Allowed: ${(allowed ?? []).join(", ") || "none"}`,
    );
  }
}
