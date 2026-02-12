import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ValidatedIntent, SolSwapMetadata } from "../queue/types";
import { createMockFlowContext } from "./context";

// Mock all external dependencies
vi.mock("@solana/kit", () => ({
  address: vi.fn((addr: string) => addr),
}));

vi.mock("@solana-program/token", () => ({
  findAssociatedTokenPda: vi.fn().mockResolvedValue(["user-ata-address"]),
  getCreateAssociatedTokenIdempotentInstruction: vi.fn().mockReturnValue({}),
  TOKEN_PROGRAM_ADDRESS: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
}));

vi.mock("@solana-program/token-2022", () => ({
  TOKEN_2022_PROGRAM_ADDRESS: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
}));

vi.mock("../constants", () => ({
  extractSolanaMintAddress: vi.fn((s: string) => s),
}));

vi.mock("../utils/solana", () => ({
  deriveAgentPublicKey: vi.fn().mockResolvedValue("SoLAgent123456789012345678901234567890123456"),
  SOLANA_DEFAULT_PATH: "solana-1",
  getSolanaRpc: vi.fn().mockReturnValue({
    getAccountInfo: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue({ value: null }) }),
  }),
  signAndBroadcastSingleSigner: vi.fn(),
  deserializeInstruction: vi.fn().mockReturnValue({}),
  getAddressLookupTableAccounts: vi.fn().mockResolvedValue([]),
  buildAndCompileTransaction: vi.fn().mockResolvedValue({
    messageBytes: new Uint8Array(32),
    compiledMessage: {},
  }),
}));

vi.mock("../utils/chainSignature", () => ({
  createDummySigner: vi.fn((addr: string) => ({ address: addr })),
}));

vi.mock("../utils/http", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../utils/authorization", () => ({
  requireUserDestination: vi.fn(),
}));

vi.mock("./registry", () => ({
  flowRegistry: { register: vi.fn() },
}));

// Import after mocks
import { solSwapFlow } from "./solSwap";

const createBaseIntent = (overrides: Partial<ValidatedIntent> = {}): ValidatedIntent => ({
  intentId: "test-intent-1",
  sourceChain: "near",
  sourceAsset: "wrap.near",
  sourceAmount: "10000000",
  destinationChain: "solana",
  intermediateAsset: "So11111111111111111111111111111111111111112",
  finalAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  userDestination: "UserSol1111111111111111111111111111111111",
  agentDestination: "AgentSol111111111111111111111111111111111",
  slippageBps: 300,
  ...overrides,
});

describe("solSwapFlow", () => {
  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(solSwapFlow.action).toBe("sol-swap");
    });

    it("has correct name", () => {
      expect(solSwapFlow.name).toBe("Solana Swap");
    });

    it("supports Solana as destination", () => {
      expect(solSwapFlow.supportedChains.destination).toContain("solana");
    });

    it("supports multiple source chains", () => {
      expect(solSwapFlow.supportedChains.source).toContain("near");
      expect(solSwapFlow.supportedChains.source).toContain("ethereum");
      expect(solSwapFlow.supportedChains.source).toContain("solana");
    });
  });

  describe("isMatch", () => {
    it("matches when destinationChain is solana and no action", () => {
      const intent = createBaseIntent({ metadata: undefined });
      expect(solSwapFlow.isMatch(intent)).toBe(true);
    });

    it("matches when destinationChain is solana and action is sol-swap", () => {
      const intent = createBaseIntent({
        metadata: { action: "sol-swap" },
      });
      expect(solSwapFlow.isMatch(intent)).toBe(true);
    });

    it("does not match when destinationChain is not solana", () => {
      const intent = createBaseIntent({ destinationChain: "near" });
      expect(solSwapFlow.isMatch(intent)).toBe(false);
    });

    it("does not match when action is a specific different action", () => {
      const intent = createBaseIntent({
        metadata: { action: "kamino-deposit", marketAddress: "x", mintAddress: "y" },
      });
      expect(solSwapFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      const { signAndBroadcastSingleSigner, getSolanaRpc } = await import("../utils/solana");
      const { fetchWithRetry } = await import("../utils/http");
      vi.mocked(signAndBroadcastSingleSigner).mockReset();
      vi.mocked(fetchWithRetry).mockReset();
      vi.mocked(getSolanaRpc).mockReturnValue({
        getAccountInfo: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue({ value: null }) }),
      } as any);
    });

    it("returns dry-run result when dryRunSwaps is true", async () => {
      const ctx = createMockFlowContext("test-intent-1", {
        config: { dryRunSwaps: true } as any,
      });
      const intent = createBaseIntent({
        metadata: { action: "sol-swap" },
      }) as ValidatedIntent & { metadata: SolSwapMetadata };

      const result = await solSwapFlow.execute(intent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("deducts ATA rent for native SOL input", async () => {
      const { fetchWithRetry } = await import("../utils/http");
      const { signAndBroadcastSingleSigner } = await import("../utils/solana");

      // Mock Jupiter responses
      vi.mocked(fetchWithRetry)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ outAmount: "5000" }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            swapInstruction: { programId: "prog", accounts: [], data: "aa" },
            addressLookupTableAddresses: [],
          }),
        } as any);
      vi.mocked(signAndBroadcastSingleSigner).mockResolvedValue("swap-tx-123");

      const intent = createBaseIntent({
        intermediateAsset: "So11111111111111111111111111111111111111112",
        sourceAmount: "10000000",
        metadata: { action: "sol-swap" },
      }) as ValidatedIntent & { metadata: SolSwapMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await solSwapFlow.execute(intent, ctx);

      expect(result.txId).toBe("swap-tx-123");
      // Verify the Jupiter quote was called with reduced amount (minus rent)
      const quoteCall = vi.mocked(fetchWithRetry).mock.calls[0][0] as string;
      expect(quoteCall).toContain("amount=");
      // 10000000 - 2100000 = 7900000
      expect(quoteCall).toContain("7900000");
    });

    it("throws when SOL amount is insufficient for ATA rent", async () => {
      const intent = createBaseIntent({
        intermediateAsset: "So11111111111111111111111111111111111111112",
        sourceAmount: "1000000", // Less than 2_100_000 rent
        metadata: { action: "sol-swap" },
      }) as ValidatedIntent & { metadata: SolSwapMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(solSwapFlow.execute(intent, ctx))
        .rejects.toThrow("Insufficient SOL amount");
    });

    it("does not deduct rent for non-SOL input", async () => {
      const { fetchWithRetry } = await import("../utils/http");
      const { signAndBroadcastSingleSigner } = await import("../utils/solana");

      vi.mocked(fetchWithRetry)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ outAmount: "5000" }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            swapInstruction: { programId: "prog", accounts: [], data: "aa" },
            addressLookupTableAddresses: [],
          }),
        } as any);
      vi.mocked(signAndBroadcastSingleSigner).mockResolvedValue("swap-tx-456");

      const intent = createBaseIntent({
        intermediateAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        sourceAmount: "1000000",
        metadata: { action: "sol-swap" },
      }) as ValidatedIntent & { metadata: SolSwapMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await solSwapFlow.execute(intent, ctx);

      expect(result.txId).toBe("swap-tx-456");
      // Amount should NOT be reduced
      const quoteCall = vi.mocked(fetchWithRetry).mock.calls[0][0] as string;
      expect(quoteCall).toContain("amount=1000000");
    });

    it("successfully executes full swap pipeline", async () => {
      const { fetchWithRetry } = await import("../utils/http");
      const { signAndBroadcastSingleSigner } = await import("../utils/solana");

      vi.mocked(fetchWithRetry)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ outAmount: "5000" }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            computeBudgetInstructions: [],
            setupInstructions: [],
            swapInstruction: { programId: "prog", accounts: [], data: "aa" },
            cleanupInstruction: null,
            otherInstructions: [],
            addressLookupTableAddresses: [],
          }),
        } as any);
      vi.mocked(signAndBroadcastSingleSigner).mockResolvedValue("final-tx-789");

      const intent = createBaseIntent({
        intermediateAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        sourceAmount: "1000000",
        metadata: { action: "sol-swap" },
      }) as ValidatedIntent & { metadata: SolSwapMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await solSwapFlow.execute(intent, ctx);

      expect(result.txId).toBe("final-tx-789");
      expect(signAndBroadcastSingleSigner).toHaveBeenCalled();
    });
  });
});
