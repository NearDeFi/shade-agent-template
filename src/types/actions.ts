/**
 * Canonical registry of all flow action identifiers.
 * Every flow's `action` field must be one of these values.
 */
export const FLOW_ACTIONS = {
  KAMINO_DEPOSIT: "kamino-deposit",
  KAMINO_WITHDRAW: "kamino-withdraw",
  BURROW_DEPOSIT: "burrow-deposit",
  BURROW_WITHDRAW: "burrow-withdraw",
  SOL_SWAP: "sol-swap",
  NEAR_SWAP: "near-swap",
  EVM_SWAP: "evm-swap",
  AAVE_DEPOSIT: "aave-deposit",
  AAVE_WITHDRAW: "aave-withdraw",
  MORPHO_DEPOSIT: "morpho-deposit",
  MORPHO_WITHDRAW: "morpho-withdraw",
  SOL_BRIDGE_OUT: "sol-bridge-out",
  NEAR_BRIDGE_OUT: "near-bridge-out",
  ORDER_CREATE: "order-create",
  ORDER_EXECUTE: "order-execute",
  ORDER_CANCEL: "order-cancel",
} as const;

export type FlowAction = typeof FLOW_ACTIONS[keyof typeof FLOW_ACTIONS];
