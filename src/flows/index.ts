/**
 * Flow Registry Index
 *
 * Imports all flows to trigger self-registration with the flow registry.
 * This file should be imported at application startup to ensure all flows
 * are registered before the queue consumer starts.
 */

// Import all flows to trigger self-registration
import "./kaminoDeposit";
import "./kaminoWithdraw";
import "./burrowDeposit";
import "./burrowWithdraw";
import "./solSwap";
import "./nearSwap";
import "./orderCreate";
import "./orderExecute";
import "./orderCancel";
import "./solBridgeOut";
import "./nearBridgeOut";
import "./evmSwap";
import "./aaveDeposit";
import "./aaveWithdraw";
import "./morphoDeposit";
import "./morphoWithdraw";

// Re-export registry and types for external use
export { flowRegistry } from "./registry";
export { createFlowContext, createMockFlowContext } from "./context";
export type {
  FlowDefinition,
  FlowContext,
  FlowResult,
  AppConfig,
  Logger,
} from "./types";

// Re-export individual flows for direct access if needed
export { kaminoDepositFlow } from "./kaminoDeposit";
export { kaminoWithdrawFlow } from "./kaminoWithdraw";
export { burrowDepositFlow } from "./burrowDeposit";
export { burrowWithdrawFlow } from "./burrowWithdraw";
export { solSwapFlow } from "./solSwap";
export { nearSwapFlow } from "./nearSwap";
export { orderCreateFlow, deriveOrderAgentAddress } from "./orderCreate";
export { orderExecuteFlow } from "./orderExecute";
export { orderCancelFlow } from "./orderCancel";
export { solBridgeOutFlow } from "./solBridgeOut";
export { nearBridgeOutFlow } from "./nearBridgeOut";
export { evmSwapFlow } from "./evmSwap";
export { aaveDepositFlow } from "./aaveDeposit";
export { aaveWithdrawFlow } from "./aaveWithdraw";
export { morphoDepositFlow } from "./morphoDeposit";
export { morphoWithdrawFlow } from "./morphoWithdraw";
