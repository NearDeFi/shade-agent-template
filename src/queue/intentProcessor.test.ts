import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createIntentProcessor,
  needsIntentsWait,
  type IntentProcessorDeps,
} from "./intentProcessor";
import type { IntentMessage, ValidatedIntent, IntentMetadata } from "./types";
import type { FlowDefinition, FlowResult } from "../flows/types";
import type { IntentStatus } from "../state/status";

// Mock refund utilities
const {
  refundSolanaTokensToUserMock,
  refundNearTokensToUserMock,
  refundEvmTokensToUserMock,
} = vi.hoisted(() => ({
  refundSolanaTokensToUserMock: vi.fn(),
  refundNearTokensToUserMock: vi.fn(),
  refundEvmTokensToUserMock: vi.fn(),
}));

vi.mock("../utils/refund", () => ({
  refundSolanaTokensToUser: refundSolanaTokensToUserMock,
  refundNearTokensToUser: refundNearTokensToUserMock,
  refundEvmTokensToUser: refundEvmTokensToUserMock,
}));

vi.mock("../utils/evmChains", () => ({
  EVM_SWAP_CHAINS: ["ethereum", "base", "arbitrum", "bnb"],
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const baseIntent: ValidatedIntent = {
  intentId: "test-1",
  sourceChain: "near",
  sourceAsset: "wrap.near",
  sourceAmount: "1000000000000000000000000",
  destinationChain: "solana",
  intermediateAsset: "So11111111111111111111111111111111111111112",
  finalAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
  agentDestination: "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
  slippageBps: 300,
};

const baseMessage: IntentMessage = { ...baseIntent };

const MOCK_METRICS_RESULT = {
  intentId: "test-1",
  flowAction: "mock",
  flowName: "Mock",
  startTime: 0,
  steps: [],
  success: false,
};

// Cast needed: MetricsCollector has private fields that plain objects can't satisfy
function createMockMetrics(): any {
  return {
    setChains: vi.fn(),
    setAmounts: vi.fn(),
    startStep: vi.fn(),
    endStep: vi.fn(),
    success: vi.fn().mockReturnValue({ ...MOCK_METRICS_RESULT, success: true }),
    failure: vi.fn().mockReturnValue({ ...MOCK_METRICS_RESULT, success: false }),
    setTxId: vi.fn(),
    setGasUsed: vi.fn(),
    getMetrics: vi.fn().mockReturnValue({ ...MOCK_METRICS_RESULT }),
  };
}

/** A same-chain intent that won't trigger needsIntentsWait */
const sameChainIntent: ValidatedIntent = {
  ...baseIntent,
  sourceChain: "solana",
  destinationChain: "solana",
  intermediateAsset: undefined,
};

function createMockDeps(overrides: Partial<IntentProcessorDeps> = {}): IntentProcessorDeps {
  return {
    appConfig: {
      maxIntentAttempts: 3,
      intentRetryBackoffMs: 100,
      dryRunSwaps: false,
    } as IntentProcessorDeps["appConfig"],
    flowCatalog: {
      get: vi.fn(),
      has: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      findMatch: vi.fn(),
    },
    validateIntent: vi.fn(() => ({ ...sameChainIntent })),
    setStatus: vi.fn(),
    createFlowContext: vi.fn(() => ({
      intentId: "test-1",
      config: {} as IntentProcessorDeps["appConfig"],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      setStatus: vi.fn(),
      metrics: createMockMetrics(),
    })),
    queue: {
      moveToDeadLetter: vi.fn(),
    },
    delay: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

function createMockFlow(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    action: "sol-swap",
    name: "Solana Swap",
    description: "Test flow",
    supportedChains: { source: ["near"], destination: ["solana"] },
    requiredMetadataFields: [],
    isMatch: vi.fn().mockReturnValue(true),
    execute: vi.fn().mockResolvedValue({ txId: "mock-tx-123" }),
    ...overrides,
  } as unknown as FlowDefinition;
}

// ─── needsIntentsWait ──────────────────────────────────────────────────────────

describe("needsIntentsWait", () => {
  it("returns false when intentsCompleted=true", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      metadata: { intentsCompleted: true } as IntentMetadata,
    };
    expect(needsIntentsWait(intent)).toBe(false);
  });

  it("returns false when userTxConfirmed=true (sell flow)", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      metadata: { userTxConfirmed: true } as IntentMetadata,
    };
    expect(needsIntentsWait(intent)).toBe(false);
  });

  it("returns true when has depositAddress + intermediateAmount", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      intentsDepositAddress: "deposit-addr-123",
      intermediateAmount: "500000",
    };
    expect(needsIntentsWait(intent)).toBe(true);
  });

  it("returns true for cross-chain with intermediateAsset", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      sourceChain: "near",
      destinationChain: "solana",
      intermediateAsset: "So11111111111111111111111111111111111111112",
    };
    expect(needsIntentsWait(intent)).toBe(true);
  });

  it("returns false for same-chain without intermediateAsset", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      sourceChain: "solana",
      destinationChain: "solana",
      intermediateAsset: undefined,
    };
    expect(needsIntentsWait(intent)).toBe(false);
  });

  it("returns false when no metadata", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      metadata: undefined,
      sourceChain: "solana",
      destinationChain: "solana",
      intermediateAsset: undefined,
    };
    expect(needsIntentsWait(intent)).toBe(false);
  });

  it("returns false when depositAddress but no intermediateAmount", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      intentsDepositAddress: "deposit-addr-123",
      intermediateAmount: undefined,
      sourceChain: "solana",
      destinationChain: "solana",
      intermediateAsset: undefined,
    };
    expect(needsIntentsWait(intent)).toBe(false);
  });
});

// ─── createIntentProcessor ─────────────────────────────────────────────────────

describe("createIntentProcessor", () => {
  describe("processIntent", () => {
    it("validates and dispatches to processIntentWithRetry", async () => {
      const flow = createMockFlow();
      const deps = createMockDeps({
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.validateIntent).toHaveBeenCalledWith(baseMessage);
      expect(deps.setStatus).toHaveBeenCalledWith("test-1", expect.objectContaining({
        state: "succeeded",
      }));
    });

    it("sets failed status when validation throws", async () => {
      const deps = createMockDeps({
        validateIntent: vi.fn(() => { throw new Error("intentId missing"); }),
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", {
        state: "failed",
        error: "intentId missing",
      });
    });

    it("sets failed status when processIntentWithRetry throws", async () => {
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("execution failed")),
      });
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", expect.objectContaining({
        state: "failed",
      }));
    });

    it("reports error message from validation failure", async () => {
      const deps = createMockDeps({
        validateIntent: vi.fn(() => { throw new Error("bad data"); }),
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", {
        state: "failed",
        error: "bad data",
      });
    });

    it("reports 'unknown error' when error has no message", async () => {
      const deps = createMockDeps({
        validateIntent: vi.fn(() => { throw {}; }),
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", {
        state: "failed",
        error: "unknown error",
      });
    });
  });

  describe("processIntentWithRetry", () => {
    it("succeeds on first attempt, sets succeeded status", async () => {
      const flow = createMockFlow();
      const deps = createMockDeps({
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", expect.objectContaining({
        state: "succeeded",
        txId: "mock-tx-123",
      }));
      expect(deps.delay).not.toHaveBeenCalled();
    });

    it("returns early for awaiting-intents result", async () => {
      const intent: ValidatedIntent = {
        ...baseIntent,
        intentsDepositAddress: "deposit-addr-123",
        intermediateAmount: "500000",
      };
      const deps = createMockDeps({
        validateIntent: vi.fn().mockReturnValue(intent),
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", expect.objectContaining({
        state: "awaiting_intents",
      }));
      // Should NOT set succeeded
      const setCalls = (deps.setStatus as ReturnType<typeof vi.fn>).mock.calls;
      const states = setCalls.map((c: unknown[]) => (c[1] as IntentStatus).state);
      expect(states).not.toContain("succeeded");
    });

    it("retries on failure up to maxIntentAttempts", async () => {
      const executeMock = vi.fn()
        .mockRejectedValueOnce(new Error("attempt 1 failed"))
        .mockRejectedValueOnce(new Error("attempt 2 failed"))
        .mockRejectedValueOnce(new Error("attempt 3 failed"));
      const flow = createMockFlow({ execute: executeMock });
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 3, intentRetryBackoffMs: 10, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(executeMock).toHaveBeenCalledTimes(3);
      expect(deps.queue.moveToDeadLetter).toHaveBeenCalledWith("raw-json");
    });

    it("applies exponential backoff (delay * attempt)", async () => {
      const executeMock = vi.fn()
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockRejectedValueOnce(new Error("fail 3"));
      const flow = createMockFlow({ execute: executeMock });
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 3, intentRetryBackoffMs: 100, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      const delayCalls = (deps.delay as ReturnType<typeof vi.fn>).mock.calls;
      expect(delayCalls[0][0]).toBe(100); // 100 * 1
      expect(delayCalls[1][0]).toBe(200); // 100 * 2
    });

    it("moves to dead letter after max attempts", async () => {
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("always fails")),
      });
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.queue.moveToDeadLetter).toHaveBeenCalledWith("raw-json");
    });

    it("attempts refund on final failure when intentsCompleted", async () => {
      refundSolanaTokensToUserMock.mockResolvedValue({ txId: "refund-tx", amount: "500000" });
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("swap failed")),
      });
      const intent: ValidatedIntent = {
        ...baseIntent,
        metadata: { intentsCompleted: true } as IntentMetadata,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(refundSolanaTokensToUserMock).toHaveBeenCalled();
    });

    it("includes refundTxId in failure status when refund succeeds", async () => {
      refundSolanaTokensToUserMock.mockResolvedValue({ txId: "refund-tx-id", amount: "500000" });
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("swap failed")),
      });
      const intent: ValidatedIntent = {
        ...baseIntent,
        metadata: { intentsCompleted: true } as IntentMetadata,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", expect.objectContaining({
        state: "failed",
        refundTxId: "refund-tx-id",
      }));
    });

    it("persists failure even when refund returns null", async () => {
      refundSolanaTokensToUserMock.mockResolvedValue(null);
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("swap failed")),
      });
      const intent: ValidatedIntent = {
        ...baseIntent,
        metadata: { intentsCompleted: true } as IntentMetadata,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", expect.objectContaining({
        state: "failed",
        error: "swap failed",
      }));
    });

    it("re-uses executedResult on retry (does not re-execute)", async () => {
      // First call to execute succeeds, but setStatus after it throws
      const executeMock = vi.fn().mockResolvedValue({ txId: "executed-tx" });
      const flow = createMockFlow({ execute: executeMock });
      let setStatusCallCount = 0;
      const setStatusMock = vi.fn().mockImplementation(async (_id: string, status: IntentStatus) => {
        setStatusCallCount++;
        // Fail the succeeded status set on first attempt
        if (status.state === "succeeded" && setStatusCallCount <= 3) {
          throw new Error("Redis write failed");
        }
      });
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 3, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        setStatus: setStatusMock,
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      // execute should only be called ONCE — subsequent retries reuse the result
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("handles status persistence failure after execution", async () => {
      const executeMock = vi.fn().mockResolvedValue({ txId: "executed-tx" });
      const flow = createMockFlow({ execute: executeMock });
      const setStatusMock = vi.fn().mockImplementation(async (_id: string, status: IntentStatus) => {
        if (status.state === "succeeded") {
          throw new Error("Redis write failed");
        }
      });
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        setStatus: setStatusMock,
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      // Should move to dead letter after max attempts
      expect(deps.queue.moveToDeadLetter).toHaveBeenCalledWith("raw-json");
    });
  });

  describe("executeIntentFlow", () => {
    it("sets awaiting_intents for intents-wait intents", async () => {
      const intent: ValidatedIntent = {
        ...baseIntent,
        intentsDepositAddress: "deposit-addr-123",
        intermediateAmount: "500000",
      };
      const deps = createMockDeps({
        validateIntent: vi.fn().mockReturnValue(intent),
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", expect.objectContaining({
        state: "awaiting_intents",
        depositAddress: "deposit-addr-123",
        intentData: intent,
      }));
    });

    it("throws when no flow matches", async () => {
      const intent: ValidatedIntent = {
        ...baseIntent,
        sourceChain: "solana",
        destinationChain: "solana",
        intermediateAsset: undefined,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([]),
          findMatch: vi.fn().mockReturnValue(undefined),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(deps.setStatus).toHaveBeenCalledWith("test-1", expect.objectContaining({
        state: "failed",
        error: expect.stringContaining("No flow registered"),
      }));
    });

    it("calls validateAuthorization if present", async () => {
      const validateAuthMock = vi.fn();
      const flow = createMockFlow({ validateAuthorization: validateAuthMock });
      const intent: ValidatedIntent = {
        ...baseIntent,
        sourceChain: "solana",
        destinationChain: "solana",
        intermediateAsset: undefined,
      };
      const deps = createMockDeps({
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(validateAuthMock).toHaveBeenCalled();
    });

    it("calls flow.execute with intent and context", async () => {
      const executeMock = vi.fn().mockResolvedValue({ txId: "tx-abc" });
      const flow = createMockFlow({ execute: executeMock });
      const intent: ValidatedIntent = {
        ...baseIntent,
        sourceChain: "solana",
        destinationChain: "solana",
        intermediateAsset: undefined,
      };
      const deps = createMockDeps({
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(executeMock).toHaveBeenCalledWith(
        expect.objectContaining({ intentId: "test-1" }),
        expect.objectContaining({ intentId: "test-1" }),
      );
    });

    it("emits success metrics after execution", async () => {
      const flow = createMockFlow();
      const successMock = vi.fn().mockReturnValue({ success: true });
      const deps = createMockDeps({
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
        createFlowContext: vi.fn(() => ({
          intentId: "test-1",
          config: {} as IntentProcessorDeps["appConfig"],
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
          setStatus: vi.fn(),
          metrics: { ...createMockMetrics(), success: successMock },
        })),
        validateIntent: vi.fn().mockReturnValue({
          ...baseIntent,
          sourceChain: "solana",
          destinationChain: "solana",
          intermediateAsset: undefined,
        }),
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(successMock).toHaveBeenCalled();
    });

    it("emits failure metrics on throw", async () => {
      const failureMock = vi.fn().mockReturnValue({ success: false });
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("kaboom")),
      });
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
        createFlowContext: vi.fn(() => ({
          intentId: "test-1",
          config: {} as IntentProcessorDeps["appConfig"],
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
          setStatus: vi.fn(),
          metrics: { ...createMockMetrics(), failure: failureMock },
        })),
        validateIntent: vi.fn().mockReturnValue({
          ...baseIntent,
          sourceChain: "solana",
          destinationChain: "solana",
          intermediateAsset: undefined,
        }),
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(failureMock).toHaveBeenCalled();
    });
  });

  describe("attemptRefund", () => {
    beforeEach(() => {
      refundSolanaTokensToUserMock.mockReset();
      refundNearTokensToUserMock.mockReset();
      refundEvmTokensToUserMock.mockReset();
    });

    it("returns null when no intermediateAsset", async () => {
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const intent: ValidatedIntent = {
        ...baseIntent,
        intermediateAsset: undefined,
        sourceChain: "solana",
        destinationChain: "solana",
        metadata: { intentsCompleted: true } as IntentMetadata,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(refundSolanaTokensToUserMock).not.toHaveBeenCalled();
      expect(refundNearTokensToUserMock).not.toHaveBeenCalled();
    });

    it("returns null when no userDestination", async () => {
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const intent: ValidatedIntent = {
        ...baseIntent,
        intermediateAsset: "So111",
        userDestination: "",
        metadata: { intentsCompleted: true } as IntentMetadata,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(refundSolanaTokensToUserMock).not.toHaveBeenCalled();
    });

    it("returns null when intentsCompleted=false", async () => {
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const intent: ValidatedIntent = {
        ...baseIntent,
        metadata: undefined,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(refundSolanaTokensToUserMock).not.toHaveBeenCalled();
      expect(refundNearTokensToUserMock).not.toHaveBeenCalled();
    });

    it("routes to refundSolanaTokensToUser for solana", async () => {
      refundSolanaTokensToUserMock.mockResolvedValue({ txId: "refund-sol", amount: "100" });
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const intent: ValidatedIntent = {
        ...baseIntent,
        destinationChain: "solana",
        metadata: { intentsCompleted: true } as IntentMetadata,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(refundSolanaTokensToUserMock).toHaveBeenCalled();
    });

    it("routes to refundNearTokensToUser for near", async () => {
      refundNearTokensToUserMock.mockResolvedValue({ txId: "refund-near", amount: "100" });
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const intent: ValidatedIntent = {
        ...baseIntent,
        destinationChain: "near",
        metadata: { intentsCompleted: true } as IntentMetadata,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(refundNearTokensToUserMock).toHaveBeenCalled();
    });

    it("routes to refundEvmTokensToUser for EVM chains", async () => {
      refundEvmTokensToUserMock.mockResolvedValue({ txId: "refund-eth", amount: "100" });
      const flow = createMockFlow({
        execute: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const intent: ValidatedIntent = {
        ...baseIntent,
        destinationChain: "ethereum",
        metadata: { intentsCompleted: true } as IntentMetadata,
      };
      const deps = createMockDeps({
        appConfig: { maxIntentAttempts: 1, intentRetryBackoffMs: 0, dryRunSwaps: false } as IntentProcessorDeps["appConfig"],
        validateIntent: vi.fn().mockReturnValue(intent),
        flowCatalog: {
          get: vi.fn(),
          has: vi.fn(),
          getAll: vi.fn().mockReturnValue([flow]),
          findMatch: vi.fn().mockReturnValue(flow),
        },
      });
      const processor = createIntentProcessor(deps);

      await processor.processIntent(baseMessage, "raw-json");

      expect(refundEvmTokensToUserMock).toHaveBeenCalled();
    });
  });
});
