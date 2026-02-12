import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ValidatedIntent, MorphoWithdrawMetadata } from "../queue/types";
import { createMockFlowContext } from "./context";

// Mock all dependencies before importing the module under test
vi.mock("viem", () => ({
  encodeFunctionData: vi.fn().mockReturnValue("0xencoded"),
}));

vi.mock("../utils/evmChains", () => ({
  EvmChainName: {},
  deriveEvmAgentAddress: vi.fn(),
  signAndBroadcastEvmTx: vi.fn(),
  getEvmPublicClient: vi.fn(),
}));

vi.mock("../utils/evmLending", () => ({
  transferEvmTokensToUser: vi.fn(),
  executeEvmBridgeBack: vi.fn(),
  MORPHO_BLUE_ADDRESS: "0xMorphoBlue",
  MORPHO_SUPPORTED_CHAINS: ["ethereum", "base"],
}));

vi.mock("../utils/authorization", () => ({
  requireUserDestination: vi.fn(),
}));

vi.mock("./registry", () => ({ flowRegistry: { register: vi.fn() } }));

// Import after mocks
import { morphoWithdrawFlow } from "./morphoWithdraw";

const createBaseIntent = (overrides: Partial<ValidatedIntent> = {}): ValidatedIntent => ({
  intentId: "test-intent-1",
  sourceChain: "ethereum",
  sourceAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  sourceAmount: "1000000000000000000",
  destinationChain: "ethereum",
  finalAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  userDestination: "0xUserAddress1234567890abcdef1234567890abcdef",
  agentDestination: "agent.near",
  slippageBps: 100,
  userSignature: {
    message: "test-message",
    signature: "test-signature",
    publicKey: "ed25519:TestPublicKey123",
    nonce: "test-nonce",
    recipient: "shade-agent.near",
  },
  ...overrides,
});

const baseMorphoMeta: MorphoWithdrawMetadata = {
  action: "morpho-withdraw",
  marketId: "0xmarket123",
  loanToken: "0xLoanToken",
  collateralToken: "0xCollateralToken",
  oracle: "0xOracle",
  irm: "0xIrm",
  lltv: "860000000000000000",
};

describe("morphoWithdrawFlow", () => {
  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(morphoWithdrawFlow.action).toBe("morpho-withdraw");
    });

    it("has correct name", () => {
      expect(morphoWithdrawFlow.name).toBe("Morpho Blue Withdraw");
    });

    it("supports ethereum and base as source", () => {
      expect(morphoWithdrawFlow.supportedChains.source).toContain("ethereum");
      expect(morphoWithdrawFlow.supportedChains.source).toContain("base");
    });

    it("has bridgeBack as optional metadata field", () => {
      expect(morphoWithdrawFlow.optionalMetadataFields).toContain("bridgeBack");
    });
  });

  describe("isMatch", () => {
    it("matches intent with morpho-withdraw action on supported chain", () => {
      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: { ...baseMorphoMeta },
      });
      expect(morphoWithdrawFlow.isMatch(intent)).toBe(true);
    });

    it("matches intent on base chain", () => {
      const intent = createBaseIntent({
        sourceChain: "base",
        metadata: { ...baseMorphoMeta },
      });
      expect(morphoWithdrawFlow.isMatch(intent)).toBe(true);
    });

    it("does not match intent with different action", () => {
      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: { action: "aave-withdraw" } as any,
      });
      expect(morphoWithdrawFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent on unsupported source chain", () => {
      const intent = createBaseIntent({
        sourceChain: "solana",
        metadata: { ...baseMorphoMeta } as any,
      });
      expect(morphoWithdrawFlow.isMatch(intent)).toBe(false);
    });

    it("does not match when marketId is missing", () => {
      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: { ...baseMorphoMeta, marketId: "" } as any,
      });
      expect(morphoWithdrawFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("validateAuthorization", () => {
    it("calls requireUserDestination", async () => {
      const { requireUserDestination } = await import("../utils/authorization");
      const intent = createBaseIntent({
        metadata: { ...baseMorphoMeta },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await morphoWithdrawFlow.validateAuthorization!(intent as any, ctx);

      expect(requireUserDestination).toHaveBeenCalledWith(intent, ctx, "Morpho withdraw");
    });

    it("throws when userSignature is missing", async () => {
      const intent = createBaseIntent({
        userSignature: undefined,
        metadata: { ...baseMorphoMeta },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await expect(
        morphoWithdrawFlow.validateAuthorization!(intent as any, ctx)
      ).rejects.toThrow("Morpho withdraw requires userSignature");
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx, getEvmPublicClient } = await import("../utils/evmChains");
      const { transferEvmTokensToUser, executeEvmBridgeBack } = await import("../utils/evmLending");
      vi.mocked(deriveEvmAgentAddress).mockReset();
      vi.mocked(signAndBroadcastEvmTx).mockReset();
      vi.mocked(getEvmPublicClient).mockReset();
      vi.mocked(transferEvmTokensToUser).mockReset();
      vi.mocked(executeEvmBridgeBack).mockReset();
    });

    it("returns dry-run result when dryRunSwaps is true", async () => {
      const ctx = createMockFlowContext("test-intent-1", {
        config: { dryRunSwaps: true } as any,
      });
      const intent = createBaseIntent({
        metadata: { ...baseMorphoMeta },
      }) as ValidatedIntent & { metadata: MorphoWithdrawMetadata };

      const result = await morphoWithdrawFlow.execute(intent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("throws when no supply position exists", async () => {
      const { deriveEvmAgentAddress, getEvmPublicClient } = await import("../utils/evmChains");
      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(getEvmPublicClient).mockReturnValue({
        readContract: vi.fn().mockResolvedValue([0n, 0n, 0n]),
      } as any);

      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: { ...baseMorphoMeta },
      }) as ValidatedIntent & { metadata: MorphoWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(morphoWithdrawFlow.execute(intent, ctx)).rejects.toThrow(
        "No supply position"
      );
    });

    it("executes withdraw and transfers tokens to user", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx, getEvmPublicClient } = await import("../utils/evmChains");
      const { transferEvmTokensToUser } = await import("../utils/evmLending");

      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(getEvmPublicClient).mockReturnValue({
        readContract: vi.fn().mockResolvedValue([5000000n, 0n, 0n]),
      } as any);
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xWithdrawTxHash");
      vi.mocked(transferEvmTokensToUser).mockResolvedValue("0xTransferTxHash");

      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: { ...baseMorphoMeta },
      }) as ValidatedIntent & { metadata: MorphoWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await morphoWithdrawFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xWithdrawTxHash");
      expect(result.txIds).toEqual(["0xWithdrawTxHash", "0xTransferTxHash"]);
      expect(signAndBroadcastEvmTx).toHaveBeenCalledWith(
        "ethereum",
        expect.objectContaining({
          from: "0xAgentAddr",
          to: "0xMorphoBlue",
        }),
        "0xUserAddress1234567890abcdef1234567890abcdef",
      );
    });

    it("executes bridgeBack when configured", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx, getEvmPublicClient } = await import("../utils/evmChains");
      const { executeEvmBridgeBack } = await import("../utils/evmLending");

      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(getEvmPublicClient).mockReturnValue({
        readContract: vi.fn().mockResolvedValue([5000000n, 0n, 0n]),
      } as any);
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xWithdrawTxHash");
      vi.mocked(executeEvmBridgeBack).mockResolvedValue({
        txId: "0xBridgeTxHash",
        depositAddress: "deposit-addr",
      });

      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: {
          ...baseMorphoMeta,
          bridgeBack: {
            destinationChain: "near",
            destinationAddress: "user.near",
            destinationAsset: "wrap.near",
          },
        },
      }) as ValidatedIntent & { metadata: MorphoWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await morphoWithdrawFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xWithdrawTxHash");
      expect(result.bridgeTxId).toBe("0xBridgeTxHash");
      expect(result.intentsDepositAddress).toBe("deposit-addr");
    });
  });
});
