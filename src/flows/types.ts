import type { config } from "../config";
import type { IntentChain, IntentMetadata, ValidatedIntent } from "../queue/types";
import type { IntentState } from "../state/status";
import type { MetricsCollector } from "./metrics";

/**
 * Application configuration type (inferred from config object)
 */
export type AppConfig = typeof config;

/**
 * Logger interface for flow execution
 */
export interface Logger {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
  debug: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Context passed to flow execution functions
 */
export interface FlowContext {
  /** Application configuration */
  config: AppConfig;
  /** Logger instance */
  logger: Logger;
  /** Update intent status in Redis */
  setStatus: (status: IntentState, detail?: Record<string, unknown>) => Promise<void>;
  /** The intent ID being processed */
  intentId: string;
  /** Metrics collector for telemetry */
  metrics: MetricsCollector;
}

/**
 * Result returned from flow execution
 */
export interface FlowResult {
  /** Primary transaction ID */
  txId: string;
  /** Additional transaction IDs for multi-tx flows */
  txIds?: string[];
  /** Bridge transaction ID if bridgeBack was executed */
  bridgeTxId?: string;
  /** Intents deposit address for cross-chain operations */
  intentsDepositAddress?: string;
  /** Amount swapped in intermediate step */
  swappedAmount?: string;
}

/**
 * Definition of a flow that can be registered and executed
 *
 * @template M - The metadata type this flow expects
 */
export interface FlowDefinition<M extends IntentMetadata = IntentMetadata> {
  // ─── Identity ────────────────────────────────────────────────────────────────
  /** Unique action identifier (e.g., "kamino-deposit") */
  action: string;
  /** Human-readable name */
  name: string;
  /** Description of what this flow does */
  description: string;

  // ─── Capabilities ────────────────────────────────────────────────────────────
  /** Chains this flow supports */
  supportedChains: {
    /** Source chains this flow can accept intents from */
    source: IntentChain[];
    /** Destination chains this flow operates on */
    destination: IntentChain[];
  };

  // ─── Validation Schema ───────────────────────────────────────────────────────
  /** Metadata fields that must be present */
  requiredMetadataFields: string[];
  /** Optional metadata fields */
  optionalMetadataFields?: string[];

  // ─── Type Guard ──────────────────────────────────────────────────────────────
  /**
   * Type guard to check if an intent matches this flow
   * Used for dispatch routing when action is not explicitly set
   */
  isMatch: (intent: ValidatedIntent) => intent is ValidatedIntent & { metadata: M };

  // ─── Execution ───────────────────────────────────────────────────────────────
  /**
   * Execute the flow
   * @param intent - The validated intent with typed metadata
   * @param ctx - Flow execution context
   * @returns Flow result with transaction ID(s)
   */
  execute: (
    intent: ValidatedIntent & { metadata: M },
    ctx: FlowContext
  ) => Promise<FlowResult>;

  // ─── Optional Hooks ──────────────────────────────────────────────────────────
  /**
   * Validate user authorization before execution
   * @throws Error if authorization fails
   */
  validateAuthorization?: (
    intent: ValidatedIntent & { metadata: M },
    ctx: FlowContext
  ) => Promise<void>;

  /**
   * Custom metadata validation beyond basic field presence checks.
   * Called during intent validation (before execution).
   * Can mutate metadata (e.g., sanitize tokenId).
   * @param metadata - The metadata object (mutable)
   * @throws Error if validation fails
   */
  validateMetadata?: (metadata: M) => void;
}

/**
 * Type helper to extract metadata type from a FlowDefinition
 */
export type FlowMetadata<F extends FlowDefinition> =
  F extends FlowDefinition<infer M> ? M : never;
