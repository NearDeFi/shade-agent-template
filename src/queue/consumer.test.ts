import { describe, expect, it, vi } from "vitest";
import { validateIntent } from "./validation";
import type { IntentMessage } from "./types";

// Mock all external dependencies
const {
  setStatusMock,
  RedisQueueClientMock,
} = vi.hoisted(() => ({
  setStatusMock: vi.fn(),
  RedisQueueClientMock: vi.fn(),
}));

vi.mock("../state/status", () => ({
  setStatus: setStatusMock,
}));

vi.mock("./redis", () => ({
  RedisQueueClient: RedisQueueClientMock,
}));

const testFlowCatalog = {
  get: () => undefined,
  has: () => false,
  getAll: () => [],
  findMatch: () => undefined,
};

function validate(intent: IntentMessage) {
  return validateIntent(intent, testFlowCatalog);
}

const baseIntent: IntentMessage = {
  intentId: "test-1",
  sourceChain: "near",
  sourceAsset: "So11111111111111111111111111111111111111112",
  sourceAmount: "1000000",
  intermediateAsset: "So11111111111111111111111111111111111111112",
  destinationAmount: "1000000",
  destinationChain: "solana",
  finalAsset: "TargetMint1111111111111111111111111111111111",
  userDestination: "UserSol1111111111111111111111111111111111",
  agentDestination: "AgentSol111111111111111111111111111111111",
};

describe("consumer validation", () => {
  describe("validateIntent", () => {
    it("accepts a valid intent and applies default slippage", () => {
      const validated = validate(baseIntent);
      expect(validated.intentId).toBe("test-1");
      expect(validated.slippageBps).toBeGreaterThan(0);
    });

    it("rejects missing required fields", () => {
      expect(() =>
        validate({
          ...baseIntent,
          intentId: "",
        }),
      ).toThrow(/intentId/);

      expect(() =>
        validate({
          ...baseIntent,
          destinationChain: "near",
        }),
      ).toThrow(/destinationChain/);

      expect(() =>
        validate({
          ...baseIntent,
          sourceAmount: "abc",
        }),
      ).toThrow(/sourceAmount/);
    });
  });
});

