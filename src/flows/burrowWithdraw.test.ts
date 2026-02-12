import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidatedIntent, BurrowWithdrawMetadata } from "../queue/types";
import { createMockFlowContext } from "./context";

// Mock problematic dependencies
vi.mock("../utils/burrow", () => ({
  getAssetsPagedDetailed: vi.fn(),
  buildWithdrawTransaction: vi.fn(),
}));

vi.mock("../utils/near", () => ({
  deriveNearAgentAccount: vi.fn(),
  ensureNearAccountFunded: vi.fn(),
  executeNearFunctionCall: vi.fn(),
  NEAR_DEFAULT_PATH: "near-1",
  GAS_FOR_FT_TRANSFER_CALL: BigInt("300000000000000"),
  ZERO_DEPOSIT: BigInt(0),
  ONE_YOCTO: BigInt(1),
}));

vi.mock("../utils/nearRpc", () => ({
  getFtBalance: vi.fn(),
}));

vi.mock("../utils/intents", () => ({
  getIntentsQuote: vi.fn(),
  createBridgeBackQuoteRequest: vi.fn(),
}));

vi.mock("../utils/tokenMappings", () => ({
  getDefuseAssetId: vi.fn(),
}));

vi.mock("./registry", () => ({
  flowRegistry: {
    register: vi.fn(),
  },
}));

// Mock authorization - we'll test the actual validation logic
const mockValidateNearWithdrawAuthorization = vi.fn();
vi.mock("../utils/authorization", () => ({
  validateNearWithdrawAuthorization: (...args: any[]) => mockValidateNearWithdrawAuthorization(...args),
}));

// Import after mocks
import { burrowWithdrawFlow } from "./burrowWithdraw";

// Base valid intent for testing
const createBaseIntent = (overrides: Partial<ValidatedIntent> = {}): ValidatedIntent => ({
  intentId: "test-intent-1",
  sourceChain: "near",
  sourceAsset: "wrap.near",
  sourceAmount: "1000000000000000000000000",
  destinationChain: "near",
  finalAsset: "wrap.near",
  userDestination: "user.near",
  agentDestination: "agent.near",
  slippageBps: 100,
  nearPublicKey: "ed25519:TestPublicKey123",
  userSignature: {
    message: "test-message",
    signature: "test-signature",
    publicKey: "ed25519:TestPublicKey123",
    nonce: "test-nonce",
    recipient: "shade-agent.near",
  },
  ...overrides,
});

describe("burrowWithdrawFlow", () => {
  beforeEach(() => {
    mockValidateNearWithdrawAuthorization.mockClear();
  });

  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(burrowWithdrawFlow.action).toBe("burrow-withdraw");
    });

    it("has correct name", () => {
      expect(burrowWithdrawFlow.name).toBe("Burrow Withdraw");
    });

    it("supports NEAR as source", () => {
      expect(burrowWithdrawFlow.supportedChains.source).toContain("near");
    });

    it("supports multiple destination chains", () => {
      expect(burrowWithdrawFlow.supportedChains.destination).toContain("near");
      expect(burrowWithdrawFlow.supportedChains.destination).toContain("ethereum");
      expect(burrowWithdrawFlow.supportedChains.destination).toContain("solana");
    });

    it("requires action and tokenId metadata fields", () => {
      expect(burrowWithdrawFlow.requiredMetadataFields).toContain("action");
      expect(burrowWithdrawFlow.requiredMetadataFields).toContain("tokenId");
    });

    it("has optional bridgeBack field", () => {
      expect(burrowWithdrawFlow.optionalMetadataFields).toContain("bridgeBack");
    });
  });

  describe("isMatch", () => {
    it("matches intent with burrow-withdraw action and tokenId", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "burrow-withdraw",
          tokenId: "wrap.near",
        },
      });
      expect(burrowWithdrawFlow.isMatch(intent)).toBe(true);
    });

    it("matches intent with bridgeBack configuration", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "burrow-withdraw",
          tokenId: "wrap.near",
          bridgeBack: {
            destinationChain: "ethereum",
            destinationAddress: "0x123...",
            destinationAsset: "eth:usdc",
          },
        },
      });
      expect(burrowWithdrawFlow.isMatch(intent)).toBe(true);
    });

    it("does not match intent with different action", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "burrow-deposit",
          tokenId: "wrap.near",
        },
      });
      expect(burrowWithdrawFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent without tokenId", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "burrow-withdraw",
        } as any,
      });
      expect(burrowWithdrawFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("validateMetadata", () => {
    it("accepts valid named account tokenId", () => {
      const metadata: BurrowWithdrawMetadata = {
        action: "burrow-withdraw",
        tokenId: "wrap.near",
      };
      expect(() => burrowWithdrawFlow.validateMetadata!(metadata)).not.toThrow();
    });

    it("strips nep141: prefix from tokenId", () => {
      const metadata: BurrowWithdrawMetadata = {
        action: "burrow-withdraw",
        tokenId: "nep141:usdt.tether-token.near",
      };
      burrowWithdrawFlow.validateMetadata!(metadata);
      expect(metadata.tokenId).toBe("usdt.tether-token.near");
    });

    it("rejects invalid tokenId format", () => {
      const metadata: BurrowWithdrawMetadata = {
        action: "burrow-withdraw",
        tokenId: "invalid-token",
      };
      expect(() => burrowWithdrawFlow.validateMetadata!(metadata)).toThrow(
        "Burrow withdraw tokenId must be a valid NEAR contract address"
      );
    });
  });

  describe("validateAuthorization", () => {
    it("calls validateNearWithdrawAuthorization", async () => {
      const intent = createBaseIntent({
        metadata: {
          action: "burrow-withdraw",
          tokenId: "wrap.near",
        },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await burrowWithdrawFlow.validateAuthorization!(intent as any, ctx);

      expect(mockValidateNearWithdrawAuthorization).toHaveBeenCalledWith(
        intent,
        ctx,
        "Burrow withdraw"
      );
    });
  });

  describe("execute", () => {
    const withdrawIntent = createBaseIntent({
      metadata: {
        action: "burrow-withdraw",
        tokenId: "wrap.near",
      },
    }) as ValidatedIntent & { metadata: BurrowWithdrawMetadata };

    beforeEach(async () => {
      const { deriveNearAgentAccount, ensureNearAccountFunded, executeNearFunctionCall } = await import("../utils/near");
      const { getAssetsPagedDetailed, buildWithdrawTransaction } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockReset();
      vi.mocked(ensureNearAccountFunded).mockReset();
      vi.mocked(executeNearFunctionCall).mockReset();
      vi.mocked(getAssetsPagedDetailed).mockReset();
      vi.mocked(buildWithdrawTransaction).mockReset();
    });

    it("returns dry-run result when dryRunSwaps is true", async () => {
      const ctx = createMockFlowContext("test-intent-1", {
        config: { dryRunSwaps: true } as any,
      });
      const result = await burrowWithdrawFlow.execute(withdrawIntent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("throws when userDestination is missing", async () => {
      const intentNoUser = createBaseIntent({
        userDestination: undefined as any,
        metadata: {
          action: "burrow-withdraw",
          tokenId: "wrap.near",
        },
      }) as ValidatedIntent & { metadata: BurrowWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(burrowWithdrawFlow.execute(intentNoUser, ctx))
        .rejects.toThrow("userDestination");
    });

    it("throws when token is not supported by Burrow", async () => {
      const { deriveNearAgentAccount } = await import("../utils/near");
      const { getAssetsPagedDetailed } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([]);

      const ctx = createMockFlowContext("test-intent-1");
      await expect(burrowWithdrawFlow.execute(withdrawIntent, ctx))
        .rejects.toThrow("Token wrap.near is not supported by Burrow");
    });

    it("throws when token cannot be withdrawn", async () => {
      const { deriveNearAgentAccount } = await import("../utils/near");
      const { getAssetsPagedDetailed } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([
        { token_id: "wrap.near", config: { can_withdraw: false } },
      ] as any);

      const ctx = createMockFlowContext("test-intent-1");
      await expect(burrowWithdrawFlow.execute(withdrawIntent, ctx))
        .rejects.toThrow("Token wrap.near cannot be withdrawn from Burrow");
    });

    it("executes withdraw successfully", async () => {
      const { deriveNearAgentAccount, executeNearFunctionCall } = await import("../utils/near");
      const { getAssetsPagedDetailed, buildWithdrawTransaction } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([
        { token_id: "wrap.near", config: { can_withdraw: true } },
      ] as any);
      vi.mocked(buildWithdrawTransaction).mockResolvedValue({
        contract_id: "contract.burrow.near",
        method_name: "withdraw",
        args: {},
      } as any);
      vi.mocked(executeNearFunctionCall).mockResolvedValue("withdraw-tx-123");

      const ctx = createMockFlowContext("test-intent-1");
      const result = await burrowWithdrawFlow.execute(withdrawIntent, ctx);

      expect(result.txId).toBe("withdraw-tx-123");
    });

    it("executes bridgeBack when configured", async () => {
      const { deriveNearAgentAccount, executeNearFunctionCall } = await import("../utils/near");
      const { getAssetsPagedDetailed, buildWithdrawTransaction } = await import("../utils/burrow");
      const { getFtBalance } = await import("../utils/nearRpc");
      const { getIntentsQuote, createBridgeBackQuoteRequest } = await import("../utils/intents");
      const { getDefuseAssetId } = await import("../utils/tokenMappings");

      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([
        { token_id: "wrap.near", config: { can_withdraw: true } },
      ] as any);
      vi.mocked(buildWithdrawTransaction).mockResolvedValue({
        contract_id: "contract.burrow.near",
        method_name: "withdraw",
        args: {},
      } as any);
      vi.mocked(executeNearFunctionCall)
        .mockResolvedValueOnce("withdraw-tx")
        .mockResolvedValueOnce("bridge-tx");
      vi.mocked(getFtBalance).mockResolvedValue("50000");
      vi.mocked(getDefuseAssetId).mockReturnValue("nep141:wrap.near");
      vi.mocked(createBridgeBackQuoteRequest).mockReturnValue({} as any);
      vi.mocked(getIntentsQuote).mockResolvedValue({ depositAddress: "deposit-addr" } as any);

      const bridgeIntent = createBaseIntent({
        metadata: {
          action: "burrow-withdraw",
          tokenId: "wrap.near",
          bridgeBack: {
            destinationChain: "ethereum",
            destinationAddress: "0x123",
            destinationAsset: "eth:usdc",
          },
        },
      }) as ValidatedIntent & { metadata: BurrowWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      const result = await burrowWithdrawFlow.execute(bridgeIntent, ctx);

      expect(result.txId).toBe("withdraw-tx");
      expect(result.bridgeTxId).toBe("bridge-tx");
      expect(result.intentsDepositAddress).toBe("deposit-addr");
    });

    it("throws when zero balance after withdrawal for bridgeBack", async () => {
      const { deriveNearAgentAccount, executeNearFunctionCall } = await import("../utils/near");
      const { getAssetsPagedDetailed, buildWithdrawTransaction } = await import("../utils/burrow");
      const { getFtBalance } = await import("../utils/nearRpc");

      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([
        { token_id: "wrap.near", config: { can_withdraw: true } },
      ] as any);
      vi.mocked(buildWithdrawTransaction).mockResolvedValue({
        contract_id: "contract.burrow.near",
        method_name: "withdraw",
        args: {},
      } as any);
      vi.mocked(executeNearFunctionCall).mockResolvedValue("withdraw-tx");
      vi.mocked(getFtBalance).mockResolvedValue("0");

      const bridgeIntent = createBaseIntent({
        metadata: {
          action: "burrow-withdraw",
          tokenId: "wrap.near",
          bridgeBack: {
            destinationChain: "ethereum",
            destinationAddress: "0x123",
            destinationAsset: "eth:usdc",
          },
        },
      }) as ValidatedIntent & { metadata: BurrowWithdrawMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(burrowWithdrawFlow.execute(bridgeIntent, ctx))
        .rejects.toThrow("No tokens available to bridge back");
    });
  });
});
