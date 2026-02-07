import { describe, expect, it, vi } from "vitest";
import { IntentMessage, KaminoDepositMetadata, KaminoWithdrawMetadata } from "./types";

// Mock flows must be hoisted for vi.mock to access them
const { mockFlows } = vi.hoisted(() => {
  const mockExecute = async () => ({ txId: "mock-tx" });

  return {
    mockFlows: {
      "kamino-deposit": {
        action: "kamino-deposit",
        name: "Kamino Deposit",
        description: "Test flow",
        supportedChains: { source: ["near", "solana"], destination: ["solana"] },
        requiredMetadataFields: ["action", "marketAddress", "mintAddress"],
        isMatch: (intent: any) => intent.metadata?.action === "kamino-deposit",
        execute: mockExecute,
      },
      "kamino-withdraw": {
        action: "kamino-withdraw",
        name: "Kamino Withdraw",
        description: "Test flow",
        supportedChains: { source: ["solana"], destination: ["solana"] },
        requiredMetadataFields: ["action", "marketAddress", "mintAddress"],
        isMatch: (intent: any) => intent.metadata?.action === "kamino-withdraw",
        execute: mockExecute,
      },
      "burrow-deposit": {
        action: "burrow-deposit",
        name: "Burrow Deposit",
        description: "Test flow",
        supportedChains: { source: ["near"], destination: ["near"] },
        requiredMetadataFields: ["action", "tokenId"],
        isMatch: (intent: any) => intent.metadata?.action === "burrow-deposit",
        execute: mockExecute,
      },
      "burrow-withdraw": {
        action: "burrow-withdraw",
        name: "Burrow Withdraw",
        description: "Test flow",
        supportedChains: { source: ["near"], destination: ["near"] },
        requiredMetadataFields: ["action", "tokenId"],
        isMatch: (intent: any) => intent.metadata?.action === "burrow-withdraw",
        execute: mockExecute,
      },
    } as Record<string, any>,
  };
});

import { validateIntent } from "./validation";

const testFlowCatalog = {
  get: (action: string) => mockFlows[action],
  has: (action: string) => action in mockFlows,
  getAll: () => Object.values(mockFlows),
  findMatch: (intent: any) => {
    const action = intent.metadata?.action;
    return action ? mockFlows[action] : undefined;
  },
};

function validate(intent: IntentMessage) {
  return validateIntent(intent, testFlowCatalog);
}

const baseIntent: IntentMessage = {
  intentId: "test-intent",
  sourceChain: "solana",
  destinationChain: "solana",
  sourceAsset: "So11111111111111111111111111111111111111111",
  finalAsset: "So11111111111111111111111111111111111111111",
  sourceAmount: "1000000",
  destinationAmount: "1000000",
  userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
  agentDestination: "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
};

describe("validateIntent", () => {
  describe("basic validation", () => {
    it("fills default slippage when omitted", () => {
      const validated = validate(baseIntent);
      expect(validated.slippageBps).toBe(300);
    });

    it("fills default intermediate asset when omitted", () => {
      const validated = validate(baseIntent);
      expect(validated.intermediateAsset).toBe(
        "So11111111111111111111111111111111111111112",
      );
    });

    it("preserves provided slippage", () => {
      const validated = validate({ ...baseIntent, slippageBps: 50 });
      expect(validated.slippageBps).toBe(50);
    });

    it("preserves provided intermediate asset", () => {
      const validated = validate({
        ...baseIntent,
        intermediateAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      });
      expect(validated.intermediateAsset).toBe(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
    });
  });

  describe("required field validation", () => {
    it("rejects missing intentId", () => {
      expect(() =>
        validate({ ...baseIntent, intentId: "" }),
      ).toThrow(/intentId/);
    });

    it("rejects missing userDestination", () => {
      expect(() =>
        validate({ ...baseIntent, userDestination: "" }),
      ).toThrow(/userDestination/);
    });

    it("rejects missing agentDestination", () => {
      expect(() =>
        validate({ ...baseIntent, agentDestination: "" }),
      ).toThrow(/agentDestination/);
    });

    it("rejects missing sourceAsset", () => {
      expect(() =>
        validate({ ...baseIntent, sourceAsset: "" }),
      ).toThrow(/sourceAsset/);
    });

    it("rejects missing finalAsset", () => {
      expect(() =>
        validate({ ...baseIntent, finalAsset: "" }),
      ).toThrow(/finalAsset/);
    });

    it("rejects non-solana destination", () => {
      expect(() =>
        validate({ ...baseIntent, destinationChain: "near" }),
      ).toThrow(/destinationChain/);
    });
  });

  describe("sourceAmount validation", () => {
    it("rejects non-numeric sourceAmount", () => {
      expect(() =>
        validate({ ...baseIntent, sourceAmount: "1.5" }),
      ).toThrow(/sourceAmount/);
    });

    it("rejects empty sourceAmount", () => {
      expect(() =>
        validate({ ...baseIntent, sourceAmount: "" }),
      ).toThrow(/sourceAmount/);
    });

    it("rejects negative sourceAmount", () => {
      expect(() =>
        validate({ ...baseIntent, sourceAmount: "-100" }),
      ).toThrow(/sourceAmount/);
    });

    it("rejects zero sourceAmount", () => {
      expect(() =>
        validate({ ...baseIntent, sourceAmount: "0" }),
      ).toThrow(/sourceAmount.*positive/i);
    });

    it("rejects sourceAmount with letters", () => {
      expect(() =>
        validate({ ...baseIntent, sourceAmount: "100abc" }),
      ).toThrow(/sourceAmount/);
    });

    it("rejects sourceAmount exceeding max value", () => {
      const hugeAmount = (2n ** 129n).toString();
      expect(() =>
        validate({ ...baseIntent, sourceAmount: hugeAmount }),
      ).toThrow(/sourceAmount.*maximum/i);
    });

    it("accepts large valid sourceAmount", () => {
      const largeAmount = (2n ** 64n).toString();
      const validated = validate({ ...baseIntent, sourceAmount: largeAmount });
      expect(validated.sourceAmount).toBe(largeAmount);
    });
  });

  describe("destinationAmount validation", () => {
    it("rejects non-numeric destinationAmount", () => {
      expect(() =>
        validate({ ...baseIntent, destinationAmount: "abc" }),
      ).toThrow(/destinationAmount/);
    });

    it("allows undefined destinationAmount", () => {
      const { destinationAmount, ...intentWithoutDestAmount } = baseIntent;
      const validated = validate(intentWithoutDestAmount as IntentMessage);
      expect(validated.destinationAmount).toBeUndefined();
    });

    it("accepts valid numeric destinationAmount", () => {
      const validated = validate({ ...baseIntent, destinationAmount: "500000" });
      expect(validated.destinationAmount).toBe("500000");
    });
  });

  describe("Kamino deposit validation", () => {
    const kaminoDepositMetadata: KaminoDepositMetadata = {
      action: "kamino-deposit",
      marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
      mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };

    it("accepts valid kamino deposit intent", () => {
      const validated = validate({
        ...baseIntent,
        metadata: kaminoDepositMetadata,
      });
      expect(validated.metadata).toEqual(kaminoDepositMetadata);
    });

    it("rejects kamino deposit without marketAddress", () => {
      const invalidMeta = {
        action: "kamino-deposit" as const,
        marketAddress: "",
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      };
      expect(() =>
        validate({ ...baseIntent, metadata: invalidMeta }),
      ).toThrow(/marketAddress/);
    });

    it("rejects kamino deposit without mintAddress", () => {
      const invalidMeta = {
        action: "kamino-deposit" as const,
        marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        mintAddress: "",
      };
      expect(() =>
        validate({ ...baseIntent, metadata: invalidMeta }),
      ).toThrow(/mintAddress/);
    });

    it("accepts kamino deposit with optional useIntents", () => {
      const metaWithIntents: KaminoDepositMetadata = {
        ...kaminoDepositMetadata,
        useIntents: true,
        slippageTolerance: 100,
      };
      const validated = validate({
        ...baseIntent,
        metadata: metaWithIntents,
      });
      expect((validated.metadata as KaminoDepositMetadata).useIntents).toBe(true);
    });
  });

  describe("Kamino withdraw validation", () => {
    const kaminoWithdrawMetadata: KaminoWithdrawMetadata = {
      action: "kamino-withdraw",
      marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
      mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };

    it("accepts valid kamino withdraw intent", () => {
      const validated = validate({
        ...baseIntent,
        metadata: kaminoWithdrawMetadata,
      });
      expect(validated.metadata).toEqual(kaminoWithdrawMetadata);
    });

    it("rejects kamino withdraw without marketAddress", () => {
      const invalidMeta = {
        action: "kamino-withdraw" as const,
        marketAddress: "",
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      };
      expect(() =>
        validate({ ...baseIntent, metadata: invalidMeta }),
      ).toThrow(/marketAddress/);
    });

    it("rejects kamino withdraw without mintAddress", () => {
      const invalidMeta = {
        action: "kamino-withdraw" as const,
        marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        mintAddress: "",
      };
      expect(() =>
        validate({ ...baseIntent, metadata: invalidMeta }),
      ).toThrow(/mintAddress/);
    });

    it("accepts kamino withdraw with bridgeBack configuration", () => {
      const metaWithBridge: KaminoWithdrawMetadata = {
        ...kaminoWithdrawMetadata,
        bridgeBack: {
          destinationChain: "zcash",
          destinationAddress: "t1abc...",
          destinationAsset: "zec:zec",
          slippageTolerance: 200,
        },
      };
      const validated = validate({
        ...baseIntent,
        metadata: metaWithBridge,
      });
      expect((validated.metadata as KaminoWithdrawMetadata).bridgeBack).toBeDefined();
    });
  });

  describe("non-Kamino metadata", () => {
    it("accepts generic metadata without action field", () => {
      const validated = validate({
        ...baseIntent,
        metadata: { customField: "value" },
      });
      expect(validated.metadata).toEqual({ customField: "value" });
    });

    it("accepts intent without metadata", () => {
      const validated = validate(baseIntent);
      expect(validated.metadata).toBeUndefined();
    });
  });
});
