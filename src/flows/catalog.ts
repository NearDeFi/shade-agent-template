import type { ValidatedIntent } from "../queue/types";
import type { FlowDefinition } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFlowDefinition = FlowDefinition<any>;

export interface FlowCatalog {
  get(action: string): AnyFlowDefinition | undefined;
  getAll(): AnyFlowDefinition[];
  findMatch(intent: ValidatedIntent): AnyFlowDefinition | undefined;
  has(action: string): boolean;
}
