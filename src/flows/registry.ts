import type { IntentChain, ValidatedIntent } from "../queue/types";
import type { FlowAction } from "../types/actions";
import type { FlowDefinition } from "./types";
import type { FlowCatalog } from "./catalog";

// Use any for the metadata type to allow registration of flows with different metadata types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFlowDefinition = FlowDefinition<any>;

/**
 * Registry for flow definitions
 * Flows self-register at module load time
 */
export class FlowRegistry implements FlowCatalog {
  private flows: Map<string, AnyFlowDefinition> = new Map();
  private defaultFlow: AnyFlowDefinition | null = null;

  /**
   * Register a flow definition
   * @param flow - The flow to register
   * @throws Error if a flow with the same action is already registered
   */
  register(flow: AnyFlowDefinition): void {
    if (this.flows.has(flow.action)) {
      throw new Error(
        `Flow with action "${flow.action}" is already registered`
      );
    }
    this.flows.set(flow.action, flow);
  }

  /**
   * Set the default flow to use when no specific flow matches
   * @param flow - The flow to use as default (typically a generic swap flow)
   */
  setDefault(flow: AnyFlowDefinition): void {
    this.defaultFlow = flow;
  }

  /**
   * Get a flow by its action identifier
   * @param action - The action string (e.g., "kamino-deposit")
   * @returns The flow definition or undefined
   */
  get(action: FlowAction): AnyFlowDefinition | undefined {
    return this.flows.get(action);
  }

  /**
   * Get all registered flows
   * @returns Array of all flow definitions
   */
  getAll(): AnyFlowDefinition[] {
    return Array.from(this.flows.values());
  }

  /**
   * Find a flow that matches the given intent
   * First tries to match by action, then falls back to type guards
   * @param intent - The validated intent
   * @returns The matching flow or default flow
   */
  findMatch(intent: ValidatedIntent): AnyFlowDefinition | undefined {
    // First: try direct action lookup, but still validate via isMatch
    const action = intent.metadata?.action;
    if (typeof action === "string") {
      const flow = this.flows.get(action);
      if (flow && flow.isMatch(intent)) return flow;
    }

    // Second: try type guard matching
    for (const flow of this.flows.values()) {
      if (flow.isMatch(intent)) {
        return flow;
      }
    }

    // Third: return default flow
    return this.defaultFlow ?? undefined;
  }

  /**
   * Get flows that support a specific destination chain
   * @param chain - The destination chain
   * @returns Array of flows supporting that chain
   */
  getByDestinationChain(chain: IntentChain): AnyFlowDefinition[] {
    return this.getAll().filter((flow) =>
      flow.supportedChains.destination.includes(chain)
    );
  }

  /**
   * Get flows that support a specific source chain
   * @param chain - The source chain
   * @returns Array of flows supporting that chain
   */
  getBySourceChain(chain: IntentChain): AnyFlowDefinition[] {
    return this.getAll().filter((flow) =>
      flow.supportedChains.source.includes(chain)
    );
  }

  /**
   * Check if a flow is registered for an action
   * @param action - The action string
   * @returns true if registered
   */
  has(action: FlowAction): boolean {
    return this.flows.has(action);
  }

  /**
   * Get count of registered flows
   */
  get size(): number {
    return this.flows.size;
  }

  /**
   * Get summary of all registered flows (useful for debugging/introspection)
   */
  getSummary(): Array<{
    action: string;
    name: string;
    description: string;
    supportedChains: AnyFlowDefinition["supportedChains"];
  }> {
    return this.getAll().map((flow) => ({
      action: flow.action,
      name: flow.name,
      description: flow.description,
      supportedChains: flow.supportedChains,
    }));
  }
}

export function createFlowRegistry(): FlowRegistry {
  return new FlowRegistry();
}
