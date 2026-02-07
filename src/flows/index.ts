import { createFlowRegistry } from "./registry";
import type { FlowCatalog } from "./catalog";
import { kaminoDepositFlow } from "./kaminoDeposit";
import { kaminoWithdrawFlow } from "./kaminoWithdraw";
import { burrowDepositFlow } from "./burrowDeposit";
import { burrowWithdrawFlow } from "./burrowWithdraw";
import { solSwapFlow } from "./solSwap";
import { nearSwapFlow } from "./nearSwap";
import { orderCreateFlow } from "./orderCreate";
import { orderExecuteFlow } from "./orderExecute";
import { orderCancelFlow } from "./orderCancel";
import { solBridgeOutFlow } from "./solBridgeOut";
import { nearBridgeOutFlow } from "./nearBridgeOut";
import { evmSwapFlow } from "./evmSwap";
import { aaveDepositFlow } from "./aaveDeposit";
import { aaveWithdrawFlow } from "./aaveWithdraw";
import { morphoDepositFlow } from "./morphoDeposit";
import { morphoWithdrawFlow } from "./morphoWithdraw";

const defaultFlows = [
  kaminoDepositFlow,
  kaminoWithdrawFlow,
  burrowDepositFlow,
  burrowWithdrawFlow,
  solSwapFlow,
  nearSwapFlow,
  orderCreateFlow,
  orderExecuteFlow,
  orderCancelFlow,
  solBridgeOutFlow,
  nearBridgeOutFlow,
  evmSwapFlow,
  aaveDepositFlow,
  aaveWithdrawFlow,
  morphoDepositFlow,
  morphoWithdrawFlow,
];

export function createDefaultFlowCatalog(): FlowCatalog {
  const registry = createFlowRegistry();
  for (const flow of defaultFlows) {
    registry.register(flow);
  }
  registry.setDefault(solSwapFlow);
  return registry;
}

// Re-export types for external use
export { createFlowContext, createMockFlowContext } from "./context";
export type {
  FlowDefinition,
  FlowContext,
  FlowResult,
  AppConfig,
  Logger,
} from "./types";
export type { FlowCatalog } from "./catalog";

// Re-export individual flows for direct access if needed
export { kaminoDepositFlow, kaminoWithdrawFlow };
export { burrowDepositFlow, burrowWithdrawFlow };
export { solSwapFlow, nearSwapFlow };
export { orderCreateFlow, deriveOrderAgentAddress } from "./orderCreate";
export { orderExecuteFlow, orderCancelFlow };
export { solBridgeOutFlow, nearBridgeOutFlow };
export { evmSwapFlow };
export { aaveDepositFlow, aaveWithdrawFlow };
export { morphoDepositFlow, morphoWithdrawFlow };
