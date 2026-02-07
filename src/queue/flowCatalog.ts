import { createDefaultFlowCatalog } from "../flows";
import {
  validateIntent,
  type IntentValidator,
} from "./validation";

// Shared immutable flow catalog for components that need intent validation.
export const flowCatalog = createDefaultFlowCatalog();
export const intentValidator: IntentValidator = (message) =>
  validateIntent(message, flowCatalog);
