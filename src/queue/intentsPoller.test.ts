import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IntentStatus } from "../state/status";
import type { ValidatedIntent, IntentMetadata } from "./types";

const {
  getIntentsByStateMock,
  setStatusMock,
  transitionStatusMock,
  enqueueIntentWithStatusMock,
  getExecutionStatusMock,
} = vi.hoisted(() => ({
  getIntentsByStateMock: vi.fn(),
  setStatusMock: vi.fn(),
  transitionStatusMock: vi.fn(),
  enqueueIntentWithStatusMock: vi.fn(),
  getExecutionStatusMock: vi.fn(),
}));

vi.mock("../state/status", () => ({
  getIntentsByState: getIntentsByStateMock,
  setStatus: setStatusMock,
  transitionStatus: transitionStatusMock,
  enqueueIntentWithStatus: enqueueIntentWithStatusMock,
}));

vi.mock("@defuse-protocol/one-click-sdk-typescript", () => ({
  OneClickService: {
    getExecutionStatus: getExecutionStatusMock,
  },
  OpenAPI: {},
}));

vi.mock("../infra/intentsApi", () => ({
  ensureIntentsApiBase: vi.fn(),
}));

// Import real production functions
import { checkAndProcessIntent, handleIntentsSuccess } from "./intentsPoller";

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

describe("checkAndProcessIntent", () => {
  beforeEach(() => {
    getExecutionStatusMock.mockReset();
    setStatusMock.mockReset();
    transitionStatusMock.mockReset();
    enqueueIntentWithStatusMock.mockReset();
  });

  it("skips without depositAddress", async () => {
    const intentStatus = {
      intentId: "test-1",
      state: "awaiting_intents" as const,
    };

    await checkAndProcessIntent(intentStatus);

    expect(getExecutionStatusMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it("calls OneClickService with depositAddress + memo", async () => {
    getExecutionStatusMock.mockResolvedValue({ status: "pending" });

    await checkAndProcessIntent({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      depositMemo: "memo-456",
      intentData: baseIntent,
    });

    expect(getExecutionStatusMock).toHaveBeenCalledWith("deposit-addr-123", "memo-456");
  });

  it("success status → transitions + re-enqueues with intentsCompleted", async () => {
    getExecutionStatusMock.mockResolvedValue({ status: "success" });
    transitionStatusMock.mockResolvedValue({ updated: true, currentStatus: { state: "processing" } });
    enqueueIntentWithStatusMock.mockResolvedValue(undefined);

    const intentWithMeta: ValidatedIntent = {
      ...baseIntent,
      metadata: { action: "sol-swap" } as IntentMetadata,
    };

    await checkAndProcessIntent({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: intentWithMeta,
    });

    expect(transitionStatusMock).toHaveBeenCalledWith(
      "test-1",
      "awaiting_intents",
      expect.objectContaining({ state: "processing" }),
    );
    expect(enqueueIntentWithStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: "test-1",
        metadata: expect.objectContaining({ intentsCompleted: true }),
      }),
      expect.objectContaining({ state: "processing" }),
    );
  });

  it("completed status → same as success", async () => {
    getExecutionStatusMock.mockResolvedValue({ status: "completed" });
    transitionStatusMock.mockResolvedValue({ updated: true, currentStatus: { state: "processing" } });
    enqueueIntentWithStatusMock.mockResolvedValue(undefined);

    await checkAndProcessIntent({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: baseIntent,
    });

    expect(transitionStatusMock).toHaveBeenCalled();
    expect(enqueueIntentWithStatusMock).toHaveBeenCalled();
  });

  it("failed/refunded → sets failed status", async () => {
    getExecutionStatusMock.mockResolvedValue({ status: "failed" });

    await checkAndProcessIntent({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: baseIntent,
    });

    expect(setStatusMock).toHaveBeenCalledWith("test-1", {
      state: "failed",
      error: "Intents swap failed",
    });
  });

  it("refunded → sets failed status with refunded message", async () => {
    getExecutionStatusMock.mockResolvedValue({ status: "refunded" });

    await checkAndProcessIntent({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: baseIntent,
    });

    expect(setStatusMock).toHaveBeenCalledWith("test-1", {
      state: "failed",
      error: "Intents swap refunded",
    });
  });

  it("pending/processing → no-ops", async () => {
    getExecutionStatusMock.mockResolvedValue({ status: "pending" });

    await checkAndProcessIntent({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: baseIntent,
    });

    expect(setStatusMock).not.toHaveBeenCalled();
    expect(transitionStatusMock).not.toHaveBeenCalled();
  });

  it("unknown status → logs, no state change", async () => {
    getExecutionStatusMock.mockResolvedValue({ status: "weird-status" });

    await checkAndProcessIntent({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: baseIntent,
    });

    expect(setStatusMock).not.toHaveBeenCalled();
    expect(transitionStatusMock).not.toHaveBeenCalled();
  });

  it("API error → catches gracefully", async () => {
    getExecutionStatusMock.mockRejectedValue(new Error("API timeout"));

    // Should not throw
    await checkAndProcessIntent({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: baseIntent,
    });

    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it("passes depositMemo to API", async () => {
    getExecutionStatusMock.mockResolvedValue({ status: "pending" });

    await checkAndProcessIntent({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      depositMemo: "memo-789",
      intentData: baseIntent,
    });

    expect(getExecutionStatusMock).toHaveBeenCalledWith("deposit-addr-123", "memo-789");
  });
});

describe("handleIntentsSuccess", () => {
  beforeEach(() => {
    setStatusMock.mockReset();
    transitionStatusMock.mockReset();
    enqueueIntentWithStatusMock.mockReset();
  });

  it("uses transitionStatus for optimistic locking", async () => {
    transitionStatusMock.mockResolvedValue({ updated: true, currentStatus: { state: "processing" } });
    enqueueIntentWithStatusMock.mockResolvedValue(undefined);

    await handleIntentsSuccess({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: baseIntent,
    });

    expect(transitionStatusMock).toHaveBeenCalledWith(
      "test-1",
      "awaiting_intents",
      expect.objectContaining({
        state: "processing",
        depositAddress: "deposit-addr-123",
        intentData: baseIntent,
      }),
    );
  });

  it("skips when transition returns updated=false", async () => {
    transitionStatusMock.mockResolvedValue({ updated: false, currentStatus: { state: "processing" } });

    await handleIntentsSuccess({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: baseIntent,
    });

    expect(enqueueIntentWithStatusMock).not.toHaveBeenCalled();
  });

  it("adds intentsCompleted=true to metadata", async () => {
    transitionStatusMock.mockResolvedValue({ updated: true, currentStatus: { state: "processing" } });
    enqueueIntentWithStatusMock.mockResolvedValue(undefined);

    const intentWithMeta: ValidatedIntent = {
      ...baseIntent,
      metadata: { action: "sol-swap" } as IntentMetadata,
    };

    await handleIntentsSuccess({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: intentWithMeta,
    });

    expect(enqueueIntentWithStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ intentsCompleted: true }),
      }),
      expect.anything(),
    );
  });

  it("rolls back to awaiting_intents on re-enqueue failure", async () => {
    transitionStatusMock.mockResolvedValue({ updated: true, currentStatus: { state: "processing" } });
    enqueueIntentWithStatusMock.mockRejectedValue(new Error("Redis full"));

    await handleIntentsSuccess({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      intentData: baseIntent,
    });

    expect(setStatusMock).toHaveBeenCalledWith("test-1", expect.objectContaining({
      state: "awaiting_intents",
      depositAddress: "deposit-addr-123",
    }));
  });

  it("fails intent when intentData missing", async () => {
    await handleIntentsSuccess({
      intentId: "test-1",
      state: "awaiting_intents" as const,
      depositAddress: "deposit-addr-123",
      // no intentData
    });

    expect(setStatusMock).toHaveBeenCalledWith("test-1", {
      state: "failed",
      error: "Missing intent data after intents success",
    });
    expect(transitionStatusMock).not.toHaveBeenCalled();
  });
});
