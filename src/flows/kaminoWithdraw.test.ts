import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedIntent, KaminoWithdrawMetadata } from "../queue/types";
import { createMockFlowContext } from "./context";

// Mock all problematic dependencies
vi.mock("@solana/kit", () => ({
  createSolanaRpc: vi.fn(),
  address: vi.fn((addr: string) => addr),
}));

vi.mock("@solana-program/token", () => ({
  findAssociatedTokenPda: vi.fn(),
  getCreateAssociatedTokenInstruction: vi.fn(),
  getTransferInstruction: vi.fn(),
  fetchToken: vi.fn(),
  TOKEN_PROGRAM_ADDRESS: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
}));

vi.mock("@solana-program/system", () => ({
  getTransferSolInstruction: vi.fn(),
}));

vi.mock("@kamino-finance/klend-sdk", () => ({
  KaminoAction: {
    buildWithdrawTxns: vi.fn(),
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
  getSolanaRpc: vi.fn(),
  signAndBroadcastDualSigner: vi.fn(),
  buildAndCompileTransaction: vi.fn(),
  createKaminoRpc: vi.fn(),
}));

vi.mock("../utils/chainSignature", () => ({
  createDummySigner: vi.fn((addr: string) => ({ address: addr })),
}));

vi.mock("../utils/tokenMappings", () => ({
  getDefuseAssetId: vi.fn(),
  getSolDefuseAssetId: vi.fn(),
}));

vi.mock("../utils/intents", () => ({
  getIntentsQuote: vi.fn(),
  createBridgeBackQuoteRequest: vi.fn(),
}));

vi.mock("./registry", () => ({
  flowRegistry: {
    register: vi.fn(),
  },
}));

// Mock authorization - we'll test the actual validation logic
const mockValidateSolanaWithdrawAuthorization = vi.fn();
vi.mock("../utils/authorization", () => ({
  validateSolanaWithdrawAuthorization: (...args: unknown[]) => mockValidateSolanaWithdrawAuthorization(...args),
}));

// Import after mocks
import { kaminoWithdrawFlow } from "./kaminoWithdraw";

// Base valid intent for testing
const createBaseIntent = (overrides: Partial<ValidatedIntent> = {}): ValidatedIntent => ({
  intentId: "test-intent-1",
  sourceChain: "solana",
  sourceAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  sourceAmount: "1000000",
  destinationChain: "solana",
  finalAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  userDestination: "SoLUserDestination123456789012345678901234567890",
  agentDestination: "SoLAgentDestination12345678901234567890123456",
  slippageBps: 100,
  userSignature: {
    message: "test-message",
    signature: "test-signature",
    publicKey: "SoLUserPubKey12345678901234567890123456789012",
    nonce: "test-nonce",
    recipient: "shade-agent.near",
  },
  ...overrides,
});

describe("kaminoWithdrawFlow", () => {
  beforeEach(() => {
    mockValidateSolanaWithdrawAuthorization.mockClear();
  });

  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(kaminoWithdrawFlow.action).toBe("kamino-withdraw");
    });

    it("has correct name", () => {
      expect(kaminoWithdrawFlow.name).toBe("Kamino Withdraw");
    });

    it("supports Solana as source", () => {
      expect(kaminoWithdrawFlow.supportedChains.source).toContain("solana");
    });

    it("supports multiple destination chains", () => {
      expect(kaminoWithdrawFlow.supportedChains.destination).toContain("solana");
      expect(kaminoWithdrawFlow.supportedChains.destination).toContain("near");
      expect(kaminoWithdrawFlow.supportedChains.destination).toContain("ethereum");
    });

    it("requires action, marketAddress, and mintAddress metadata fields", () => {
      expect(kaminoWithdrawFlow.requiredMetadataFields).toContain("action");
      expect(kaminoWithdrawFlow.requiredMetadataFields).toContain("marketAddress");
      expect(kaminoWithdrawFlow.requiredMetadataFields).toContain("mintAddress");
    });

    it("has optional bridgeBack field", () => {
      expect(kaminoWithdrawFlow.optionalMetadataFields).toContain("bridgeBack");
    });
  });

  describe("isMatch", () => {
    it("matches intent with kamino-withdraw action and required fields", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-withdraw",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      });
      expect(kaminoWithdrawFlow.isMatch(intent)).toBe(true);
    });

    it("matches intent with bridgeBack configuration", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-withdraw",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          bridgeBack: {
            destinationChain: "near",
            destinationAddress: "user.near",
            destinationAsset: "wrap.near",
          },
        },
      });
      expect(kaminoWithdrawFlow.isMatch(intent)).toBe(true);
    });

    it("does not match intent with different action", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-deposit",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      });
      expect(kaminoWithdrawFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent without marketAddress", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-withdraw",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        } as any,
      });
      expect(kaminoWithdrawFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent without mintAddress", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-withdraw",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        } as any,
      });
      expect(kaminoWithdrawFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("validateAuthorization", () => {
    it("calls validateSolanaWithdrawAuthorization", async () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-withdraw",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await kaminoWithdrawFlow.validateAuthorization!(intent as any, ctx);

      expect(mockValidateSolanaWithdrawAuthorization).toHaveBeenCalledWith(
        intent,
        ctx,
        "Kamino withdraw"
      );
    });
  });

  describe("execute", () => {
    const withdrawIntent = createBaseIntent({
      metadata: {
        action: "kamino-withdraw",
        marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    }) as ValidatedIntent & { metadata: KaminoWithdrawMetadata };

    beforeEach(async () => {
      const { KaminoMarket, KaminoAction } = await import("@kamino-finance/klend-sdk");
      const { signAndBroadcastDualSigner } = await import("../utils/solana");
      vi.mocked(KaminoMarket.load).mockReset();
      vi.mocked(KaminoAction.buildWithdrawTxns).mockReset();
      vi.mocked(signAndBroadcastDualSigner).mockReset();
    });

    it("returns dry-run result when dryRunSwaps is true", async () => {
      const ctx = createMockFlowContext("test-intent-1", {
        config: { dryRunSwaps: true } as any,
      });
      const result = await kaminoWithdrawFlow.execute(withdrawIntent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("throws when Kamino market fails to load", async () => {
      const { KaminoMarket } = await import("@kamino-finance/klend-sdk");
      vi.mocked(KaminoMarket.load).mockResolvedValue(null as any);

      const ctx = createMockFlowContext("test-intent-1");
      await expect(kaminoWithdrawFlow.execute(withdrawIntent, ctx))
        .rejects.toThrow("Failed to load Kamino market");
    });

    it("throws when reserve not found for mint", async () => {
      const { KaminoMarket } = await import("@kamino-finance/klend-sdk");
      vi.mocked(KaminoMarket.load).mockResolvedValue({
        getReserveByMint: vi.fn().mockReturnValue(null),
      } as any);

      const ctx = createMockFlowContext("test-intent-1");
      await expect(kaminoWithdrawFlow.execute(withdrawIntent, ctx))
        .rejects.toThrow("Reserve not found for mint");
    });

    it("executes withdraw successfully", async () => {
      const { KaminoMarket, KaminoAction } = await import("@kamino-finance/klend-sdk");
      const { signAndBroadcastDualSigner, buildAndCompileTransaction } = await import("../utils/solana");

      vi.mocked(KaminoMarket.load).mockResolvedValue({
        getReserveByMint: vi.fn().mockReturnValue({
          getLiquidityMint: vi.fn().mockReturnValue("mint-addr"),
        }),
      } as any);
      vi.mocked(KaminoAction.buildWithdrawTxns).mockResolvedValue({
        computeBudgetIxs: [{}],
        setupIxs: [],
        lendingIxs: [{}],
        cleanupIxs: [],
      } as any);
      vi.mocked(buildAndCompileTransaction).mockResolvedValue({
        messageBytes: new Uint8Array(32),
        compiledMessage: {},
      } as any);
      vi.mocked(signAndBroadcastDualSigner).mockResolvedValue("withdraw-tx-123");

      const ctx = createMockFlowContext("test-intent-1");
      const result = await kaminoWithdrawFlow.execute(withdrawIntent, ctx);

      expect(result.txId).toBe("withdraw-tx-123");
    });

    it("executes bridgeBack when configured", async () => {
      const { KaminoMarket, KaminoAction } = await import("@kamino-finance/klend-sdk");
      const { signAndBroadcastDualSigner, buildAndCompileTransaction, getSolanaRpc } = await import("../utils/solana");
      const { fetchToken } = await import("@solana-program/token");
      const { findAssociatedTokenPda } = await import("@solana-program/token");
      const { getIntentsQuote, createBridgeBackQuoteRequest } = await import("../utils/intents");
      const { getDefuseAssetId } = await import("../utils/tokenMappings");

      vi.mocked(KaminoMarket.load).mockResolvedValue({
        getReserveByMint: vi.fn().mockReturnValue({
          getLiquidityMint: vi.fn().mockReturnValue("mint-addr"),
        }),
      } as any);
      vi.mocked(KaminoAction.buildWithdrawTxns).mockResolvedValue({
        computeBudgetIxs: [],
        setupIxs: [],
        lendingIxs: [{}],
        cleanupIxs: [],
      } as any);
      vi.mocked(buildAndCompileTransaction).mockResolvedValue({
        messageBytes: new Uint8Array(32),
        compiledMessage: {},
      } as any);
      vi.mocked(signAndBroadcastDualSigner)
        .mockResolvedValueOnce("withdraw-tx")
        .mockResolvedValueOnce("bridge-tx");
      vi.mocked(findAssociatedTokenPda).mockResolvedValue(["ata-address"] as any);
      vi.mocked(fetchToken).mockResolvedValue({ data: { amount: 50000n } } as any);
      vi.mocked(getSolanaRpc).mockReturnValue({
        getAccountInfo: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue({ value: null }) }),
      } as any);
      vi.mocked(getDefuseAssetId).mockReturnValue("nep141:token.omft.near");
      vi.mocked(createBridgeBackQuoteRequest).mockReturnValue({} as any);
      vi.mocked(getIntentsQuote).mockResolvedValue({ depositAddress: "deposit-addr" } as any);

      const bridgeIntent = createBaseIntent({
        metadata: {
          action: "kamino-withdraw",
          marketAddress: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
          mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          bridgeBack: {
            destinationChain: "near",
            destinationAddress: "user.near",
            destinationAsset: "wrap.near",
          },
        },
      }) as ValidatedIntent & { metadata: KaminoWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await kaminoWithdrawFlow.execute(bridgeIntent, ctx);

      expect(result.txId).toBe("withdraw-tx");
      expect(result.bridgeTxId).toBe("bridge-tx");
      expect(result.intentsDepositAddress).toBe("deposit-addr");
    });
  });
});
