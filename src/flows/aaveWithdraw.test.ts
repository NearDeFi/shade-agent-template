import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ValidatedIntent, AaveWithdrawMetadata } from "../queue/types";
import { createMockFlowContext } from "./context";

// Mock all dependencies before importing the module under test
vi.mock("viem", () => ({
  encodeFunctionData: vi.fn().mockReturnValue("0xencoded"),
  maxUint256: 2n ** 256n - 1n,
}));

vi.mock("../utils/evmChains", () => ({
  EvmChainName: {},
  deriveEvmAgentAddress: vi.fn(),
  signAndBroadcastEvmTx: vi.fn(),
}));

vi.mock("../utils/evmLending", () => ({
  transferEvmTokensToUser: vi.fn(),
  executeEvmBridgeBack: vi.fn(),
  AAVE_POOL_ADDRESSES: { ethereum: "0xPool", base: "0xPool2", arbitrum: "0xPool3" },
  AAVE_SUPPORTED_CHAINS: ["ethereum", "base", "arbitrum"],
}));

vi.mock("../utils/authorization", () => ({
  requireUserDestination: vi.fn(),
}));

vi.mock("./registry", () => ({ flowRegistry: { register: vi.fn() } }));

// Import after mocks
import { aaveWithdrawFlow } from "./aaveWithdraw";

// Base valid intent for testing
const createBaseIntent = (overrides: Partial<ValidatedIntent> = {}): ValidatedIntent => ({
  intentId: "test-intent-1",
  sourceChain: "ethereum",
  sourceAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  sourceAmount: "1000000",
  destinationChain: "ethereum",
  finalAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  userDestination: "0xUserAddress1234567890abcdef1234567890abcdef",
  agentDestination: "agent.near",
  slippageBps: 100,
  userSignature: {
    message: "test-message",
    signature: "test-signature",
    publicKey: "ed25519:ABC123",
    nonce: "test-nonce",
    recipient: "shade-agent.near",
  },
  ...overrides,
});

describe("aaveWithdrawFlow", () => {
  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(aaveWithdrawFlow.action).toBe("aave-withdraw");
    });

    it("has correct name", () => {
      expect(aaveWithdrawFlow.name).toBe("Aave V3 Withdraw");
    });

    it("supports EVM chains as source", () => {
      expect(aaveWithdrawFlow.supportedChains.source).toContain("ethereum");
      expect(aaveWithdrawFlow.supportedChains.source).toContain("base");
      expect(aaveWithdrawFlow.supportedChains.source).toContain("arbitrum");
    });
  });

  describe("isMatch", () => {
    it("matches intent with aave-withdraw action and underlyingAsset on supported chain", () => {
      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: {
          action: "aave-withdraw",
          underlyingAsset: "0xTokenAddr",
        },
      });
      expect(aaveWithdrawFlow.isMatch(intent)).toBe(true);
    });

    it("matches intent on arbitrum chain", () => {
      const intent = createBaseIntent({
        sourceChain: "arbitrum",
        metadata: {
          action: "aave-withdraw",
          underlyingAsset: "0xTokenAddr",
        },
      });
      expect(aaveWithdrawFlow.isMatch(intent)).toBe(true);
    });

    it("does not match intent with different action", () => {
      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: {
          action: "aave-deposit",
          underlyingAsset: "0xTokenAddr",
        } as any,
      });
      expect(aaveWithdrawFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent without underlyingAsset", () => {
      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: {
          action: "aave-withdraw",
        } as any,
      });
      expect(aaveWithdrawFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("validateAuthorization", () => {
    it("calls requireUserDestination", async () => {
      const { requireUserDestination } = await import("../utils/authorization");
      const intent = createBaseIntent({
        metadata: {
          action: "aave-withdraw",
          underlyingAsset: "0xTokenAddr",
        },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await aaveWithdrawFlow.validateAuthorization!(intent as any, ctx);

      expect(requireUserDestination).toHaveBeenCalledWith(intent, ctx, "Aave withdraw");
    });

    it("throws when userSignature is missing", async () => {
      const intent = createBaseIntent({
        userSignature: undefined,
        metadata: {
          action: "aave-withdraw",
          underlyingAsset: "0xTokenAddr",
        },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await expect(
        aaveWithdrawFlow.validateAuthorization!(intent as any, ctx)
      ).rejects.toThrow("Aave withdraw requires userSignature for authorization");
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx } = await import("../utils/evmChains");
      const { transferEvmTokensToUser, executeEvmBridgeBack } = await import("../utils/evmLending");
      vi.mocked(deriveEvmAgentAddress).mockReset();
      vi.mocked(signAndBroadcastEvmTx).mockReset();
      vi.mocked(transferEvmTokensToUser).mockReset();
      vi.mocked(executeEvmBridgeBack).mockReset();
    });

    it("returns dry-run result when dryRunSwaps is true", async () => {
      const ctx = createMockFlowContext("test-intent-1", {
        config: { dryRunSwaps: true } as any,
      });
      const intent = createBaseIntent({
        metadata: {
          action: "aave-withdraw",
          underlyingAsset: "0xTokenAddr",
        },
      }) as ValidatedIntent & { metadata: AaveWithdrawMetadata };

      const result = await aaveWithdrawFlow.execute(intent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("throws when no pool address for chain", async () => {
      const { deriveEvmAgentAddress } = await import("../utils/evmChains");
      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");

      const intent = createBaseIntent({
        sourceChain: "bnb" as any,
        metadata: {
          action: "aave-withdraw",
          underlyingAsset: "0xTokenAddr",
        },
      }) as ValidatedIntent & { metadata: AaveWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(aaveWithdrawFlow.execute(intent, ctx)).rejects.toThrow(
        "No Aave V3 pool address"
      );
    });

    it("executes withdraw and transfers to user without bridgeBack", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx } = await import("../utils/evmChains");
      const { transferEvmTokensToUser } = await import("../utils/evmLending");

      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xWithdrawTxHash");
      vi.mocked(transferEvmTokensToUser).mockResolvedValue("0xTransferTxHash");

      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: {
          action: "aave-withdraw",
          underlyingAsset: "0xTokenAddr",
        },
      }) as ValidatedIntent & { metadata: AaveWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await aaveWithdrawFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xWithdrawTxHash");
      expect(result.txIds).toEqual(["0xWithdrawTxHash", "0xTransferTxHash"]);
      expect(transferEvmTokensToUser).toHaveBeenCalledWith(
        "ethereum",
        "0xTokenAddr",
        "0xAgentAddr",
        "0xUserAddress1234567890abcdef1234567890abcdef",
        expect.anything(),
      );
    });

    it("executes withdraw with bridgeBack", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx } = await import("../utils/evmChains");
      const { executeEvmBridgeBack } = await import("../utils/evmLending");

      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xWithdrawTxHash");
      vi.mocked(executeEvmBridgeBack).mockResolvedValue({
        txId: "0xBridgeTxHash",
        depositAddress: "bridge-deposit-addr",
      });

      const intent = createBaseIntent({
        sourceChain: "ethereum",
        metadata: {
          action: "aave-withdraw",
          underlyingAsset: "0xTokenAddr",
          bridgeBack: {
            destinationChain: "near",
            destinationAddress: "user.near",
            destinationAsset: "wrap.near",
          },
        },
      }) as ValidatedIntent & { metadata: AaveWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await aaveWithdrawFlow.execute(intent, ctx);

      expect(result.txId).toBe("0xWithdrawTxHash");
      expect(result.bridgeTxId).toBe("0xBridgeTxHash");
      expect(result.intentsDepositAddress).toBe("bridge-deposit-addr");
      expect(executeEvmBridgeBack).toHaveBeenCalledWith(
        "ethereum",
        "0xTokenAddr",
        "0xAgentAddr",
        "0xUserAddress1234567890abcdef1234567890abcdef",
        expect.objectContaining({
          destinationChain: "near",
          destinationAddress: "user.near",
          destinationAsset: "wrap.near",
        }),
        "1000000",
        expect.anything(),
        expect.anything(),
      );
    });

    it("sends withdraw tx to correct pool address", async () => {
      const { deriveEvmAgentAddress, signAndBroadcastEvmTx } = await import("../utils/evmChains");
      const { transferEvmTokensToUser } = await import("../utils/evmLending");

      vi.mocked(deriveEvmAgentAddress).mockResolvedValue("0xAgentAddr");
      vi.mocked(signAndBroadcastEvmTx).mockResolvedValue("0xWithdrawTxHash");
      vi.mocked(transferEvmTokensToUser).mockResolvedValue("0xTransferTxHash");

      const intent = createBaseIntent({
        sourceChain: "base",
        metadata: {
          action: "aave-withdraw",
          underlyingAsset: "0xTokenAddr",
        },
      }) as ValidatedIntent & { metadata: AaveWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await aaveWithdrawFlow.execute(intent, ctx);

      expect(signAndBroadcastEvmTx).toHaveBeenCalledWith(
        "base",
        expect.objectContaining({
          from: "0xAgentAddr",
          to: "0xPool2",
        }),
        "0xUserAddress1234567890abcdef1234567890abcdef",
      );
    });
  });
});
