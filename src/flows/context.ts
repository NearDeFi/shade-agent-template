import { config } from "../config";
import { setStatus, IntentStatus } from "../state/status";
import type { IntentState } from "../state/status";
import { MetricsCollector } from "./metrics";
import { createLogger } from "../utils/logger";
import type { AppConfig, FlowContext, Logger } from "./types";

const defaultLogger = createLogger("flow");

/**
 * Options for creating a flow context
 */
export interface CreateFlowContextOptions {
  /** Intent ID for status updates */
  intentId: string;
  /** Custom config (defaults to global config) */
  config?: AppConfig;
  /** Custom logger (defaults to console logger) */
  logger?: Logger;
  /** Custom setStatus function (defaults to Redis-backed) */
  setStatus?: (status: IntentState, detail?: Record<string, unknown>) => Promise<void>;
  /** Flow action identifier for metrics */
  flowAction?: string;
  /** Flow human-readable name for metrics */
  flowName?: string;
}

/**
 * Create a flow context for executing a flow
 *
 * @param options - Context options
 * @returns FlowContext instance
 */
export function createFlowContext(options: CreateFlowContextOptions): FlowContext {
  const { intentId, logger = defaultLogger } = options;
  const appConfig = options.config ?? config;

  // Create setStatus wrapper that adds the intentId
  const setStatusFn =
    options.setStatus ??
    (async (status: IntentState, detail?: Record<string, unknown>) => {
      const statusPayload: IntentStatus = {
        state: status,
        ...detail,
      };
      await setStatus(intentId, statusPayload);
    });

  // Create metrics collector
  const metrics = new MetricsCollector(
    intentId,
    options.flowAction ?? "unknown",
    options.flowName ?? "Unknown Flow",
  );

  return {
    config: appConfig,
    logger,
    setStatus: setStatusFn,
    intentId,
    metrics,
  };
}

/**
 * Create a mock flow context for testing
 *
 * @param intentId - Intent ID for the context
 * @param overrides - Optional overrides for config, logger, or setStatus
 * @returns FlowContext instance with mock implementations
 */
export function createMockFlowContext(
  intentId: string,
  overrides?: Partial<Pick<FlowContext, "config" | "logger" | "setStatus" | "metrics">>
): FlowContext {
  const mockLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  // Create a mock metrics collector (or use provided override)
  const mockMetrics = overrides?.metrics ?? new MetricsCollector(intentId, "mock", "Mock Flow");

  return {
    intentId,
    config: overrides?.config ?? config,
    logger: overrides?.logger ?? mockLogger,
    setStatus: overrides?.setStatus ?? (async () => {}),
    metrics: mockMetrics,
  };
}

// ─── Debug Logging Helpers ──────────────────────────────────────────────────────

/**
 * NEAR agent account info for debug logging
 */
export interface NearAgentInfo {
  accountId: string;
  derivationPath: string;
}

/**
 * Log debug info for NEAR flows with derived agent accounts
 */
export function logNearAddressInfo(
  logger: Logger,
  userDestination: string,
  agent: NearAgentInfo,
): void {
  logger.info("=== ADDRESS DEBUG INFO ===");
  logger.info(`User destination: ${userDestination}`);
  logger.info(`Derived NEAR account: ${agent.accountId}`);
  logger.info(`Derivation path: ${agent.derivationPath}`);
}

/**
 * Log debug info for Solana flows using Defuse intents
 */
export function logSolanaIntentsInfo(
  logger: Logger,
  userDestination: string,
  agentDestination: string | undefined,
  intentsDepositAddress: string | undefined,
): void {
  logger.info("=== ADDRESS DEBUG INFO ===");
  logger.info(`User destination address (NEAR): ${userDestination}`);
  logger.info(`Agent destination (from intent): ${agentDestination}`);
  logger.info(`Intents deposit address (first leg sent here): ${intentsDepositAddress}`);
}
