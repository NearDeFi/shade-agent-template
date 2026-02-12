import { describe, expect, it, vi, beforeEach } from "vitest";
import { ValidatedIntent, KaminoDepositMetadata } from "../queue/types";
import { createMockFlowContext } from "./context";

// Mock all problematic dependencies
vi.mock("@solana/kit", () => ({
  createSolanaRpc: vi.fn(),
  address: vi.fn((addr: string) => addr),
  pipe: vi.fn((...fns: any[]) => {
    let result = fns[0];
    for (let i = 1; i < fns.length; i++) {
      result = fns[i](result);
    }
    return result;
  }),
  createTransactionMessage: vi.fn(),
  appendTransactionMessageInstructions: vi.fn(),
  setTransactionMessageFeePayerSigner: vi.fn(),
  setTransactionMessageLifetimeUsingBlockhash: vi.fn(),
  compileTransaction: vi.fn(),
}));

vi.mock("@solana-program/system", () => ({
  getTransferSolInstruction: vi.fn(),
}));

vi.mock("@kamino-finance/klend-sdk", () => ({
  KaminoAction: {
    buildDepositTxns: vi.fn(),
  },
  KaminoMarket: {
    load: vi.fn(),
  },
  PROGRAM_ID: "KLend2g3cP87ber41GRxsMGb8NuxWuYjL3Jv12FYQMSEn",
  VanillaObligation: vi.fn(),
}));

vi.mock("bn.js", () => ({
  default: vi.fn((val: string) => ({ toString: () => val })),
}));

vi.mock("../utils/solana", () => ({
  deriveAgentPublicKey: vi.fn().mockResolvedValue("SoLAgentPubKey123456789012345678901234567890"),
  SOLANA_DEFAULT_PATH: "solana-1",
  createKaminoRpc: vi.fn().mockReturnValue({
    getBalance: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue({ value: 100_000_000n }) }),
  }),
  broadcastSolanaTx: vi.fn(),
  buildAndCompileTransaction: vi.fn().mockResolvedValue({
    messageBytes: new Uint8Array(32),
    compiledMessage: {},
  }),
  attachMultipleSignaturesToCompiledTx: vi.fn().mockReturnValue(new Uint8Array(32)),
}));

vi.mock("../utils/chainSignature", () => ({
  signWithNearChainSignatures: vi.fn().mockResolvedValue(new Uint8Array(64)),
  createDummySigner: vi.fn((addr: string) => ({ address: addr })),
}));

const mockRequireUserDestination = vi.fn();
vi.mock("../utils/authorization", () => ({
  requireUserDestination: (...args: unknown[]) => mockRequireUserDestination(...args),
}));

vi.mock("./registry", () => ({
  flowRegistry: {
    register: vi.fn(),
  },
}));

// Import after mocks
import { kaminoDepositFlow } from "./kaminoDeposit";

// Base valid intent for testing
const createBaseIntent = (overrides: Partial<ValidatedIntent> = {}): ValidatedIntent => ({
  intentId: "test-intent-1",
  sourceChain: "near",
  sourceAsset: "wrap.near",
  sourceAmount: "1000000000000000000000000",
  destinationChain: "solana",
  finalAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  userDestination: "SoLUserDestination123456789012345678901234567890",
  agentDestination: "SoLAgentDestination12345678901234567890123456",
  slippageBps: 100,
  ...overrides,
});

describe("kaminoDepositFlow", () => {
  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(kaminoDepositFlow.action).toBe("kamino-deposit");
    });

    it("has correct name", () => {
      expect(kaminoDepositFlow.name).toBe("Kamino Deposit");
    });

    it("supports multiple source chains", () => {
      expect(kaminoDepositFlow.supportedChains.source).toContain("near");
      expect(kaminoDepositFlow.supportedChains.source).toContain("ethereum");
      expect(kaminoDepositFlow.supportedChains.source).toContain("solana");
    });

    it("supports Solana as destination", () => {
      expect(kaminoDepositFlow.supportedChains.destination).toContain("solana");
    });

    it("requires action, marketAddress, and mintAddress metadata fields", () => {
      expect(kaminoDepositFlow.requiredMetadataFields).toContain("action");
      expect(kaminoDepositFlow.requiredMetadataFields).toContain("marketAddress");
      expect(kaminoDepositFlow.requiredMetadataFields).toContain("mintAddress");
    });

    it("has optional fields for intents configuration", () => {
      expect(kaminoDepositFlow.optionalMetadataFields).toContain("targetDefuseAssetId");
      expect(kaminoDepositFlow.optionalMetadataFields).toContain("useIntents");
      expect(kaminoDepositFlow.optionalMetadataFields).toContain("slippageTolerance");
    });
  });

  describe("isMatch", () => {
    it("matches intent with kamino-deposit action and required fields", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-deposit",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      });
      expect(kaminoDepositFlow.isMatch(intent)).toBe(true);
    });

    it("does not match intent with different action", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-withdraw",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      });
      expect(kaminoDepositFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent without marketAddress", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-deposit",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        } as any,
      });
      expect(kaminoDepositFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent without mintAddress", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-deposit",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        } as any,
      });
      expect(kaminoDepositFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent without metadata", () => {
      const intent = createBaseIntent({ metadata: undefined });
      expect(kaminoDepositFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("validateAuthorization", () => {
    beforeEach(() => {
      mockRequireUserDestination.mockReset();
    });

    it("calls requireUserDestination", async () => {
      const intent = createBaseIntent({
        userDestination: "SoLUserDestination123456789012345678901234567890",
        metadata: {
          action: "kamino-deposit",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await kaminoDepositFlow.validateAuthorization!(intent as any, ctx);

      expect(mockRequireUserDestination).toHaveBeenCalledWith(
        intent,
        ctx,
        "Kamino deposit"
      );
    });

    it("propagates error from requireUserDestination", async () => {
      mockRequireUserDestination.mockImplementation(() => {
        throw new Error("Kamino deposit requires userDestination");
      });

      const intent = createBaseIntent({
        userDestination: undefined as any,
        metadata: {
          action: "kamino-deposit",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await expect(
        kaminoDepositFlow.validateAuthorization!(intent as any, ctx)
      ).rejects.toThrow("Kamino deposit requires userDestination");
    });
  });

  describe("execute", () => {
    const depositIntent = createBaseIntent({
      metadata: {
        action: "kamino-deposit",
        marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    }) as ValidatedIntent & { metadata: KaminoDepositMetadata };

    beforeEach(async () => {
      const { KaminoMarket, KaminoAction } = await import("@kamino-finance/klend-sdk");
      const { broadcastSolanaTx } = await import("../utils/solana");
      const { signWithNearChainSignatures } = await import("../utils/chainSignature");
      vi.mocked(KaminoMarket.load).mockReset();
      vi.mocked(KaminoAction.buildDepositTxns).mockReset();
      vi.mocked(broadcastSolanaTx).mockReset();
      vi.mocked(signWithNearChainSignatures).mockReset();
      vi.mocked(signWithNearChainSignatures).mockResolvedValue(new Uint8Array(64));
    });

    it("returns dry-run result when dryRunSwaps is true", async () => {
      const ctx = createMockFlowContext("test-intent-1", {
        config: { dryRunSwaps: true } as any,
      });
      const result = await kaminoDepositFlow.execute(depositIntent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("throws when Kamino market fails to load", async () => {
      const { KaminoMarket } = await import("@kamino-finance/klend-sdk");
      vi.mocked(KaminoMarket.load).mockResolvedValue(null as any);

      const ctx = createMockFlowContext("test-intent-1");
      await expect(kaminoDepositFlow.execute(depositIntent, ctx))
        .rejects.toThrow("Failed to load Kamino market");
    });

    it("throws when reserve not found for mint", async () => {
      const { KaminoMarket } = await import("@kamino-finance/klend-sdk");
      vi.mocked(KaminoMarket.load).mockResolvedValue({
        getReserveByMint: vi.fn().mockReturnValue(null),
      } as any);

      const ctx = createMockFlowContext("test-intent-1");
      await expect(kaminoDepositFlow.execute(depositIntent, ctx))
        .rejects.toThrow("Reserve not found for mint");
    });

    it("executes deposit successfully with dual signing", async () => {
      const { KaminoMarket, KaminoAction } = await import("@kamino-finance/klend-sdk");
      const { broadcastSolanaTx } = await import("../utils/solana");

      vi.mocked(KaminoMarket.load).mockResolvedValue({
        getReserveByMint: vi.fn().mockReturnValue({
          getLiquidityMint: vi.fn().mockReturnValue("mint-addr"),
        }),
      } as any);
      vi.mocked(KaminoAction.buildDepositTxns).mockResolvedValue({
        computeBudgetIxs: [{}],
        setupIxs: [],
        lendingIxs: [{}],
        cleanupIxs: [],
      } as any);
      vi.mocked(broadcastSolanaTx).mockResolvedValue("kamino-deposit-tx-123");

      const ctx = createMockFlowContext("test-intent-1");
      const result = await kaminoDepositFlow.execute(depositIntent, ctx);

      expect(result.txId).toBe("kamino-deposit-tx-123");
    });

    it("uses intermediateAmount when available", async () => {
      const { KaminoMarket, KaminoAction } = await import("@kamino-finance/klend-sdk");
      const { broadcastSolanaTx } = await import("../utils/solana");
      const BN = (await import("bn.js")).default;

      vi.mocked(KaminoMarket.load).mockResolvedValue({
        getReserveByMint: vi.fn().mockReturnValue({
          getLiquidityMint: vi.fn().mockReturnValue("mint-addr"),
        }),
      } as any);
      vi.mocked(KaminoAction.buildDepositTxns).mockResolvedValue({
        computeBudgetIxs: [],
        setupIxs: [],
        lendingIxs: [{}],
        cleanupIxs: [],
      } as any);
      vi.mocked(broadcastSolanaTx).mockResolvedValue("tx-123");

      const intentWithIntermediate = createBaseIntent({
        intermediateAmount: "5000",
        metadata: {
          action: "kamino-deposit",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      }) as ValidatedIntent & { metadata: KaminoDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await kaminoDepositFlow.execute(intentWithIntermediate, ctx);

      expect(result.swappedAmount).toBe("5000");
      expect(BN).toHaveBeenCalledWith("5000");
    });
  });
});
