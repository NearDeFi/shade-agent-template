import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ValidatedIntent, MorphoDepositMetadata } from "../queue/types";
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
  MORPHO_BLUE_ADDRESS: "0xMorphoBlue",
  MORPHO_SUPPORTED_CHAINS: ["ethereum", "base"],
}));

vi.mock("../utils/authorization", () => ({
  requireUserDestination: vi.fn(),
}));

vi.mock("./registry", () => ({ flowRegistry: { register: vi.fn() } }));

// Import after mocks
import { morphoDepositFlow } from "./morphoDeposit";

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

const baseMorphoMeta: MorphoDepositMetadata = {
  action: "morpho-deposit",
  marketId: "0xmarket123",
  loanToken: "0xLoanToken",
  collateralToken: "0xCollateralToken",
  oracle: "0xOracle",
  irm: "0xIrm",
  lltv: "860000000000000000",
};

describe("morphoDepositFlow", () => {
  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(morphoDepositFlow.action).toBe("morpho-deposit");
    });

    it("has correct name", () => {
      expect(morphoDepositFlow.name).toBe("Morpho Blue Deposit");
    });

    it("supports ethereum and base as destination", () => {
      expect(morphoDepositFlow.supportedChains.destination).toContain("ethereum");
      expect(morphoDepositFlow.supportedChains.destination).toContain("base");
    });
  });

  describe("isMatch", () => {
    it("matches intent with morpho-deposit action on supported chain", () => {
      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { ...baseMorphoMeta },
      });
      expect(morphoDepositFlow.isMatch(intent)).toBe(true);
    });

    it("matches intent on base chain", () => {
      const intent = createBaseIntent({
        destinationChain: "base",
        metadata: { ...baseMorphoMeta },
      });
      expect(morphoDepositFlow.isMatch(intent)).toBe(true);
    });

    it("does not match intent with different action", () => {
      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { action: "aave-deposit" } as any,
      });
      expect(morphoDepositFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent on unsupported chain", () => {
      const intent = createBaseIntent({
        destinationChain: "solana",
        metadata: { ...baseMorphoMeta } as any,
      });
      expect(morphoDepositFlow.isMatch(intent)).toBe(false);
    });

    it("does not match when marketId is missing", () => {
      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { ...baseMorphoMeta, marketId: "" } as any,
      });
      expect(morphoDepositFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("validateAuthorization", () => {
    it("calls requireUserDestination", async () => {
      const { requireUserDestination } = await import("../utils/authorization");
      const intent = createBaseIntent({
        metadata: { ...baseMorphoMeta },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await morphoDepositFlow.validateAuthorization!(intent as any, ctx);

      expect(requireUserDestination).toHaveBeenCalledWith(intent, ctx, "Morpho deposit");
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
        metadata: { ...baseMorphoMeta },
      }) as ValidatedIntent & { metadata: MorphoDepositMetadata };

      const result = await morphoDepositFlow.execute(intent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("throws when token balance is zero", async () => {
      const { deriveEvmAgentAddress, getEvmTokenBalance } = await import("../utils/evmChains");
      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(getEvmTokenBalance).mockResolvedValue(0n);

      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { ...baseMorphoMeta },
      }) as ValidatedIntent & { metadata: MorphoDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(morphoDepositFlow.execute(intent, ctx)).rejects.toThrow(
        "No token balance"
      );
    });

    it("executes deposit successfully with approve and supply", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx, getEvmTokenBalance } = await import("../utils/evmChains");
      const { ensureErc20Allowance } = await import("../utils/evmLending");

      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(getEvmTokenBalance).mockResolvedValue(5000000n);
      vi.mocked(ensureErc20Allowance).mockResolvedValue("0xApproveTxHash");
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xSupplyTxHash");

      const intent = createBaseIntent({
        destinationChain: "ethereum",
        metadata: { ...baseMorphoMeta },
      }) as ValidatedIntent & { metadata: MorphoDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await morphoDepositFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xSupplyTxHash");
      expect(result.txIds).toContain("0xApproveTxHash");
      expect(result.txIds).toContain("0xSupplyTxHash");
      expect(result.swappedAmount).toBe("5000000");
      expect(signAndBroadcastEvmTx).toHaveBeenCalledWith(
        "ethereum",
        expect.objectContaining({
          from: "0xAgentAddr",
          to: "0xMorphoBlue",
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
        metadata: { ...baseMorphoMeta },
      }) as ValidatedIntent & { metadata: MorphoDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await morphoDepositFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xSupplyTxHash");
      expect(result.txIds).toEqual(["0xSupplyTxHash"]);
    });
  });
});
