import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ValidatedIntent, AaveDepositMetadata } from "../queue/types";
import { createMockFlowContext } from "./context";

// Mock all dependencies before importing the module under test
vi.mock("viem", () => ({
  encodeFunctionData: vi.fn().mockReturnValue("0xencoded"),
}));

vi.mock("../constants", () => ({
  extractEvmTokenAddress: vi.fn((s: string) => s),
}));

vi.mock("../utils/evmChains", () => ({
  EvmChainName: {},
  deriveEvmAgentAddress: vi.fn(),
  signAndBroadcastEvmTx: vi.fn(),
  getEvmTokenBalance: vi.fn(),
}));

vi.mock("../utils/evmLending", () => ({
  ensureErc20Allowance: vi.fn(),
  AAVE_POOL_ADDRESSES: { ethereum: "0xPool", base: "0xPool2", arbitrum: "0xPool3" },
  AAVE_SUPPORTED_CHAINS: ["ethereum", "base", "arbitrum"],
}));

vi.mock("../utils/authorization", () => ({
  requireUserDestination: vi.fn(),
}));

vi.mock("./registry", () => ({ flowRegistry: { register: vi.fn() } }));

// Import after mocks
import { aaveDepositFlow } from "./aaveDeposit";

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

describe("aaveDepositFlow", () => {
  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(aaveDepositFlow.action).toBe("aave-deposit");
    });

    it("has correct name", () => {
      expect(aaveDepositFlow.name).toBe("Aave V3 Deposit");
    });

    it("supports EVM chains as destination", () => {
      expect(aaveDepositFlow.supportedChains.destination).toContain("ethereum");
      expect(aaveDepositFlow.supportedChains.destination).toContain("base");
      expect(aaveDepositFlow.supportedChains.destination).toContain("arbitrum");
    });
  });

  describe("isMatch", () => {
    it("matches intent with aave-deposit action on supported chain", () => {
      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { action: "aave-deposit" },
      });
      expect(aaveDepositFlow.isMatch(intent)).toBe(true);
    });

    it("matches intent on base chain", () => {
      const intent = createBaseIntent({
        destinationChain: "base",
        metadata: { action: "aave-deposit" },
      });
      expect(aaveDepositFlow.isMatch(intent)).toBe(true);
    });

    it("does not match intent with different action", () => {
      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { action: "morpho-deposit" } as any,
      });
      expect(aaveDepositFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent on unsupported chain", () => {
      const intent = createBaseIntent({
        destinationChain: "solana",
        metadata: { action: "aave-deposit" } as any,
      });
      expect(aaveDepositFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("validateAuthorization", () => {
    it("calls requireUserDestination", async () => {
      const { requireUserDestination } = await import("../utils/authorization");
      const intent = createBaseIntent({
        metadata: { action: "aave-deposit" },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await aaveDepositFlow.validateAuthorization!(intent as any, ctx);

      expect(requireUserDestination).toHaveBeenCalledWith(intent, ctx, "Aave deposit");
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx, getEvmTokenBalance } = await import("../utils/evmChains");
      const { ensureErc20Allowance } = await import("../utils/evmLending");
      vi.mocked(deriveEvmAgentAddress).mockReset();
      vi.mocked(signAndBroadcastEvmTx).mockReset();
      vi.mocked(getEvmTokenBalance).mockReset();
      vi.mocked(ensureErc20Allowance).mockReset();
    });

    it("returns dry-run result when dryRunSwaps is true", async () => {
      const ctx = createMockFlowContext("test-intent-1", {
        config: { dryRunSwaps: true } as any,
      });
      const intent = createBaseIntent({
        metadata: { action: "aave-deposit" },
      }) as ValidatedIntent & { metadata: AaveDepositMetadata };

      const result = await aaveDepositFlow.execute(intent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("throws when token balance is zero", async () => {
      const { deriveEvmAgentAddress, getEvmTokenBalance } = await import("../utils/evmChains");
      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(getEvmTokenBalance).mockResolvedValue(0n);

      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { action: "aave-deposit" },
      }) as ValidatedIntent & { metadata: AaveDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(aaveDepositFlow.execute(intent, ctx)).rejects.toThrow(
        "No token balance"
      );
    });

    it("throws when no pool address for chain", async () => {
      const { deriveEvmAgentAddress, getEvmTokenBalance } = await import("../utils/evmChains");
      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(getEvmTokenBalance).mockResolvedValue(1000000n);

      const intent = createBaseIntent({
        destinationChain: "bnb" as any, // bnb not in AAVE_POOL_ADDRESSES mock
        metadata: { action: "aave-deposit" },
      }) as ValidatedIntent & { metadata: AaveDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(aaveDepositFlow.execute(intent, ctx)).rejects.toThrow(
        "No Aave V3 pool address"
      );
    });

    it("executes deposit successfully and returns txId and txIds", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx, getEvmTokenBalance } = await import("../utils/evmChains");
      const { ensureErc20Allowance } = await import("../utils/evmLending");

      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(getEvmTokenBalance).mockResolvedValue(5000000n);
      vi.mocked(ensureErc20Allowance).mockResolvedValue("0xApproveTxHash");
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xSupplyTxHash");

      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { action: "aave-deposit" },
      }) as ValidatedIntent & { metadata: AaveDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await aaveDepositFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xSupplyTxHash");
      expect(result.txIds).toContain("0xApproveTxHash");
      expect(result.txIds).toContain("0xSupplyTxHash");
      expect(result.swappedAmount).toBe("5000000");
      expect(signAndBroadcastEvmTx).toHaveBeenCalledWith(
        "ethereum",
        expect.objectContaining({
          from: "0xAgentAddr",
          to: "0xPool",
        }),
        "0xUserAddress1234567890abcdef1234567890abcdef",
      );
    });

    it("skips approve tx when ensureErc20Allowance returns null", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx, getEvmTokenBalance } = await import("../utils/evmChains");
      const { ensureErc20Allowance } = await import("../utils/evmLending");

      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(getEvmTokenBalance).mockResolvedValue(5000000n);
      vi.mocked(ensureErc20Allowance).mockResolvedValue(null as any);
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xSupplyTxHash");

      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { action: "aave-deposit" },
      }) as ValidatedIntent & { metadata: AaveDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await aaveDepositFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xSupplyTxHash");
      expect(result.txIds).toEqual(["0xSupplyTxHash"]);
    });
  });
});
