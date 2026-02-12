import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ValidatedIntent, EvmSwapMetadata } from "../queue/types";
import { createMockFlowContext } from "./context";

// Mock all dependencies before importing the module under test
vi.mock("../utils/evmChains", () => ({
  EVM_SWAP_CHAINS: ["ethereum", "base", "arbitrum", "bnb"],
  EvmChainName: {},
  deriveEvmAgentAddress: vi.fn(),
  signAndBroadcastEvmTx: vi.fn(),
  EVM_CHAIN_CONFIGS: { ethereum: { zeroExBaseUrl: "https://api.0x.org" } },
}));

vi.mock("../utils/evmLending", () => ({
  ensureErc20Allowance: vi.fn(),
  transferEvmTokensToUser: vi.fn(),
}));

vi.mock("../utils/http", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../utils/common", () => ({
  isNativeEvmToken: vi.fn(),
}));

vi.mock("../utils/authorization", () => ({
  requireUserDestination: vi.fn(),
}));

vi.mock("../constants", () => ({
  extractEvmTokenAddress: vi.fn((s: string) => s),
}));

vi.mock("../config", () => ({
  config: { dryRunSwaps: false, zeroExApiKey: "", zeroExMaxAttempts: 3, zeroExRetryBackoffMs: 100 },
}));

vi.mock("./registry", () => ({ flowRegistry: { register: vi.fn() } }));

// Import after mocks
import { evmSwapFlow } from "./evmSwap";

// Base valid intent for testing
const createBaseIntent = (overrides: Partial<ValidatedIntent> = {}): ValidatedIntent => ({
  intentId: "test-intent-1",
  sourceChain: "near",
  sourceAsset: "wrap.near",
  sourceAmount: "1000000000000000000",
  destinationChain: "ethereum",
  finalAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  userDestination: "0xUserAddress1234567890abcdef1234567890abcdef",
  agentDestination: "agent.near",
  slippageBps: 100,
  ...overrides,
});

describe("evmSwapFlow", () => {
  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(evmSwapFlow.action).toBe("evm-swap");
    });

    it("has correct name", () => {
      expect(evmSwapFlow.name).toBe("EVM Swap");
    });

    it("supports EVM chains as destination", () => {
      expect(evmSwapFlow.supportedChains.destination).toContain("ethereum");
      expect(evmSwapFlow.supportedChains.destination).toContain("base");
      expect(evmSwapFlow.supportedChains.destination).toContain("arbitrum");
      expect(evmSwapFlow.supportedChains.destination).toContain("bnb");
    });
  });

  describe("isMatch", () => {
    it("matches intent with EVM destination chain", () => {
      const intent = createBaseIntent({ destinationChain: "ethereum" });
      expect(evmSwapFlow.isMatch(intent)).toBe(true);
    });

    it("matches intent with evm-swap action", () => {
      const intent = createBaseIntent({
        destinationChain: "base",
        metadata: { action: "evm-swap" },
      });
      expect(evmSwapFlow.isMatch(intent)).toBe(true);
    });

    it("does not match non-EVM destination chain", () => {
      const intent = createBaseIntent({ destinationChain: "solana" });
      expect(evmSwapFlow.isMatch(intent)).toBe(false);
    });

    it("does not match different action on EVM chain", () => {
      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { action: "aave-deposit" } as any,
      });
      expect(evmSwapFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx } = await import("../utils/evmChains");
      const { ensureErc20Allowance, transferEvmTokensToUser } = await import("../utils/evmLending");
      const { fetchWithRetry } = await import("../utils/http");
      const { isNativeEvmToken } = await import("../utils/common");
      vi.mocked(deriveEvmAgentAddress).mockReset();
      vi.mocked(signAndBroadcastEvmTx).mockReset();
      vi.mocked(ensureErc20Allowance).mockReset();
      vi.mocked(transferEvmTokensToUser).mockReset();
      vi.mocked(fetchWithRetry).mockReset();
      vi.mocked(isNativeEvmToken).mockReset();
    });

    it("returns dry-run result when dryRunSwaps is true", async () => {
      const ctx = createMockFlowContext("test-intent-1", {
        config: { dryRunSwaps: true } as any,
      });
      const intent = createBaseIntent({
        metadata: { action: "evm-swap" },
      }) as ValidatedIntent & { metadata: EvmSwapMetadata };

      const result = await evmSwapFlow.execute(intent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("deducts gas reserve for native token sell", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx } = await import("../utils/evmChains");
      const { transferEvmTokensToUser } = await import("../utils/evmLending");
      const { fetchWithRetry } = await import("../utils/http");
      const { isNativeEvmToken } = await import("../utils/common");

      vi.mocked(isNativeEvmToken).mockReturnValue(true);
      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(fetchWithRetry).mockResolvedValue({
        ok: true,
        json: async () => ({
          to: "0xSwapTarget",
          data: "0xswapdata",
          value: "0",
          buyAmount: "500000",
          allowanceTarget: "0xAllowance",
          estimatedGas: "21000",
        }),
      } as any);
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xSwapTxHash");
      vi.mocked(transferEvmTokensToUser).mockResolvedValue("0xTransferTxHash");

      const intent = createBaseIntent({
        sourceAmount: "10000000000000000000", // 10 ETH in wei
        destinationChain: "ethereum",
        metadata: { action: "evm-swap" },
      }) as ValidatedIntent & { metadata: EvmSwapMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await evmSwapFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xSwapTxHash");
      // The 0x quote should be called with reduced amount (10 ETH - 0.008 ETH gas reserve)
      expect(fetchWithRetry).toHaveBeenCalled();
    });

    it("throws insufficient gas error for native sell with too-small amount", async () => {
      const { deriveEvmAgentAddress } = await import("../utils/evmChains");
      const { isNativeEvmToken } = await import("../utils/common");

      vi.mocked(isNativeEvmToken).mockReturnValue(true);
      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");

      const intent = createBaseIntent({
        sourceAmount: "100000", // tiny amount, less than gas reserve
        destinationChain: "ethereum",
        metadata: { action: "evm-swap" },
      }) as ValidatedIntent & { metadata: EvmSwapMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(evmSwapFlow.execute(intent, ctx)).rejects.toThrow(
        "Insufficient native token amount"
      );
    });

    it("calls ensureErc20Allowance for non-native token sell", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx } = await import("../utils/evmChains");
      const { ensureErc20Allowance, transferEvmTokensToUser } = await import("../utils/evmLending");
      const { fetchWithRetry } = await import("../utils/http");
      const { isNativeEvmToken } = await import("../utils/common");

      vi.mocked(isNativeEvmToken).mockReturnValue(false);
      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(fetchWithRetry).mockResolvedValue({
        ok: true,
        json: async () => ({
          to: "0xSwapTarget",
          data: "0xswapdata",
          value: "0",
          buyAmount: "500000",
          allowanceTarget: "0xAllowanceTarget",
          estimatedGas: "21000",
        }),
      } as any);
      vi.mocked(ensureErc20Allowance).mockResolvedValue("0xApproveTxHash");
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xSwapTxHash");
      vi.mocked(transferEvmTokensToUser).mockResolvedValue("0xTransferTxHash");

      const intent = createBaseIntent({
        sourceAmount: "1000000",
        destinationChain: "ethereum",
        metadata: { action: "evm-swap" },
      }) as ValidatedIntent & { metadata: EvmSwapMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await evmSwapFlow.execute(intent, ctx);

      expect(ensureErc20Allowance).toHaveBeenCalled();
    });

    it("returns txId and txIds on success", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx } = await import("../utils/evmChains");
      const { ensureErc20Allowance, transferEvmTokensToUser } = await import("../utils/evmLending");
      const { fetchWithRetry } = await import("../utils/http");
      const { isNativeEvmToken } = await import("../utils/common");

      vi.mocked(isNativeEvmToken).mockReturnValue(false);
      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(fetchWithRetry).mockResolvedValue({
        ok: true,
        json: async () => ({
          to: "0xSwapTarget",
          data: "0xswapdata",
          value: "0",
          buyAmount: "999000",
          allowanceTarget: "0xAllowanceTarget",
          estimatedGas: "21000",
        }),
      } as any);
      vi.mocked(ensureErc20Allowance).mockResolvedValue("0xApproveTxHash");
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xSwapTxHash");
      vi.mocked(transferEvmTokensToUser).mockResolvedValue("0xTransferTxHash");

      const intent = createBaseIntent({
        sourceAmount: "1000000",
        destinationChain: "ethereum",
        metadata: { action: "evm-swap" },
      }) as ValidatedIntent & { metadata: EvmSwapMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await evmSwapFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xSwapTxHash");
      expect(result.txIds).toContain("0xApproveTxHash");
      expect(result.txIds).toContain("0xSwapTxHash");
      expect(result.txIds).toContain("0xTransferTxHash");
      expect(result.swappedAmount).toBe("999000");
    });
  });
});
