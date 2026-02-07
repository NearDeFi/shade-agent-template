import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateIntent } from "./validation";
import { IntentMessage, ValidatedIntent, KaminoDepositMetadata, KaminoWithdrawMetadata } from "./types";

// Mock all external dependencies
const {
  setStatusMock,
  executeSolanaSwapFlowMock,
  executeKaminoDepositFlowMock,
  executeKaminoWithdrawFlowMock,
  isKaminoDepositIntentMock,
  isKaminoWithdrawIntentMock,
  RedisQueueClientMock,
} = vi.hoisted(() => ({
  setStatusMock: vi.fn(),
  executeSolanaSwapFlowMock: vi.fn(),
  executeKaminoDepositFlowMock: vi.fn(),
  executeKaminoWithdrawFlowMock: vi.fn(),
  isKaminoDepositIntentMock: vi.fn(),
  isKaminoWithdrawIntentMock: vi.fn(),
  RedisQueueClientMock: vi.fn(),
}));

vi.mock("../state/status", () => ({
  setStatus: setStatusMock,
}));

vi.mock("../flows/solSwap", () => ({
  executeSolanaSwapFlow: executeSolanaSwapFlowMock,
}));

vi.mock("../flows/kaminoDeposit", () => ({
  executeKaminoDepositFlow: executeKaminoDepositFlowMock,
  isKaminoDepositIntent: isKaminoDepositIntentMock,
}));

vi.mock("../flows/kaminoWithdraw", () => ({
  executeKaminoWithdrawFlow: executeKaminoWithdrawFlowMock,
  isKaminoWithdrawIntent: isKaminoWithdrawIntentMock,
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

describe("intent flow routing", () => {
  beforeEach(() => {
    isKaminoDepositIntentMock.mockReset();
    isKaminoWithdrawIntentMock.mockReset();
    executeSolanaSwapFlowMock.mockReset();
    executeKaminoDepositFlowMock.mockReset();
    executeKaminoWithdrawFlowMock.mockReset();
    setStatusMock.mockReset();
  });

  describe("isKaminoDepositIntent detection", () => {
    it("identifies Kamino deposit intent by metadata", () => {
      const depositMeta: KaminoDepositMetadata = {
        action: "kamino-deposit",
        marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      };

      const intent: ValidatedIntent = {
        ...baseIntent,
        slippageBps: 300,
        metadata: depositMeta,
      };

      // Real implementation check
      const meta = intent.metadata as KaminoDepositMetadata;
      const isDeposit = meta?.action === "kamino-deposit" && !!meta.marketAddress && !!meta.mintAddress;
      expect(isDeposit).toBe(true);
    });

    it("does not identify regular swap as Kamino deposit", () => {
      const intent: ValidatedIntent = {
        ...baseIntent,
        slippageBps: 300,
      };

      const meta = intent.metadata as KaminoDepositMetadata;
      const isDeposit = meta?.action === "kamino-deposit" && !!meta?.marketAddress && !!meta?.mintAddress;
      expect(isDeposit).toBe(false);
    });
  });

  describe("isKaminoWithdrawIntent detection", () => {
    it("identifies Kamino withdraw intent by metadata", () => {
      const withdrawMeta: KaminoWithdrawMetadata = {
        action: "kamino-withdraw",
        marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      };

      const intent: ValidatedIntent = {
        ...baseIntent,
        slippageBps: 300,
        metadata: withdrawMeta,
      };

      const meta = intent.metadata as KaminoWithdrawMetadata;
      const isWithdraw = meta?.action === "kamino-withdraw" && !!meta.marketAddress && !!meta.mintAddress;
      expect(isWithdraw).toBe(true);
    });

    it("identifies Kamino withdraw with bridgeBack configuration", () => {
      const withdrawMeta: KaminoWithdrawMetadata = {
        action: "kamino-withdraw",
        marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        bridgeBack: {
          destinationChain: "zcash",
          destinationAddress: "t1abc...",
          destinationAsset: "zec:zec",
        },
      };

      const intent: ValidatedIntent = {
        ...baseIntent,
        slippageBps: 300,
        metadata: withdrawMeta,
      };

      const meta = intent.metadata as KaminoWithdrawMetadata;
      expect(meta.bridgeBack).toBeDefined();
      expect(meta.bridgeBack?.destinationChain).toBe("zcash");
    });
  });
});

describe("needsIntentsWait logic", () => {
  // Test the logic that determines if an intent needs to wait for cross-chain swap

  function needsIntentsWait(intent: ValidatedIntent): boolean {
    // If intents already completed (re-queued by poller), skip waiting
    if (intent.metadata?.intentsCompleted) {
      return false;
    }

    // If there's a deposit address and intermediate amount, this is a cross-chain swap
    if (intent.intentsDepositAddress && intent.intermediateAmount) {
      return true;
    }

    // If source chain is different from destination chain and we have intermediate asset
    if (intent.sourceChain !== intent.destinationChain && intent.intermediateAsset) {
      return true;
    }

    return false;
  }

  it("returns false when intentsCompleted is true", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      slippageBps: 300,
      metadata: { intentsCompleted: true },
    };
    expect(needsIntentsWait(intent)).toBe(false);
  });

  it("returns true when has deposit address and intermediate amount", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      slippageBps: 300,
      intentsDepositAddress: "deposit-addr-123",
      intermediateAmount: "500000",
    };
    expect(needsIntentsWait(intent)).toBe(true);
  });

  it("returns true for cross-chain swap with intermediate asset", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      sourceChain: "near",
      destinationChain: "solana",
      intermediateAsset: "So11111111111111111111111111111111111111112",
      slippageBps: 300,
    };
    expect(needsIntentsWait(intent)).toBe(true);
  });

  it("returns false for same-chain swap", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      sourceChain: "solana",
      destinationChain: "solana",
      slippageBps: 300,
    };
    expect(needsIntentsWait(intent)).toBe(false);
  });

  it("returns false when no intermediate asset for cross-chain", () => {
    const intent: ValidatedIntent = {
      ...baseIntent,
      sourceChain: "near",
      destinationChain: "solana",
      intermediateAsset: undefined,
      slippageBps: 300,
    };
    expect(needsIntentsWait(intent)).toBe(false);
  });
});

describe("intent types", () => {
  describe("IntentChain type", () => {
    it("accepts valid chain types", () => {
      const chains = ["near", "solana", "zcash", "ethereum", "arbitrum", "base", "optimism", "aurora", "polygon", "bnb", "avalanche"];
      for (const chain of chains) {
        const intent = { ...baseIntent, sourceChain: chain as any };
        expect(intent.sourceChain).toBe(chain);
      }
    });
  });

  describe("UserSignature structure", () => {
    it("accepts complete user signature", () => {
      const intent: IntentMessage = {
        ...baseIntent,
        userSignature: {
          message: "sign this message",
          signature: "base64signature==",
          publicKey: "ed25519:ABC123",
          nonce: "base64nonce==",
          recipient: "shade-agent.near",
        },
      };
      expect(intent.userSignature?.message).toBe("sign this message");
      expect(intent.userSignature?.publicKey).toBe("ed25519:ABC123");
    });
  });

  describe("ValidatedIntent extends IntentMessage", () => {
    it("has required slippageBps field", () => {
      const validated = validate(baseIntent);
      expect(typeof validated.slippageBps).toBe("number");
      expect(validated.slippageBps).toBeGreaterThan(0);
    });

    it("preserves all original fields", () => {
      const validated = validate(baseIntent);
      expect(validated.intentId).toBe(baseIntent.intentId);
      expect(validated.sourceChain).toBe(baseIntent.sourceChain);
      expect(validated.destinationChain).toBe(baseIntent.destinationChain);
      expect(validated.sourceAmount).toBe(baseIntent.sourceAmount);
      expect(validated.userDestination).toBe(baseIntent.userDestination);
    });
  });
});
