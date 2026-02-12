import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ValidatedIntent, BurrowDepositMetadata } from "../queue/types";
import { createMockFlowContext } from "./context";

// Mock problematic dependencies
vi.mock("../utils/burrow", () => ({
  getAssetsPagedDetailed: vi.fn(),
  buildSupplyTransaction: vi.fn(),
}));

vi.mock("../utils/near", () => ({
  deriveNearAgentAccount: vi.fn(),
  ensureNearAccountFunded: vi.fn(),
  executeNearFunctionCall: vi.fn(),
  NEAR_DEFAULT_PATH: "near-1",
  GAS_FOR_FT_TRANSFER_CALL: BigInt("300000000000000"),
  ONE_YOCTO: BigInt(1),
}));

vi.mock("./registry", () => ({
  flowRegistry: {
    register: vi.fn(),
  },
}));

// Import after mocks
import { burrowDepositFlow } from "./burrowDeposit";

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
  ...overrides,
});

describe("burrowDepositFlow", () => {
  describe("flow definition", () => {
    it("has correct action identifier", () => {
      expect(burrowDepositFlow.action).toBe("burrow-deposit");
    });

    it("has correct name", () => {
      expect(burrowDepositFlow.name).toBe("Burrow Deposit");
    });

    it("supports NEAR as destination", () => {
      expect(burrowDepositFlow.supportedChains.destination).toContain("near");
    });

    it("supports multiple source chains", () => {
      expect(burrowDepositFlow.supportedChains.source).toContain("near");
      expect(burrowDepositFlow.supportedChains.source).toContain("ethereum");
      expect(burrowDepositFlow.supportedChains.source).toContain("solana");
    });

    it("requires action and tokenId metadata fields", () => {
      expect(burrowDepositFlow.requiredMetadataFields).toContain("action");
      expect(burrowDepositFlow.requiredMetadataFields).toContain("tokenId");
    });
  });

  describe("isMatch", () => {
    it("matches intent with burrow-deposit action and tokenId", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "burrow-deposit",
          tokenId: "wrap.near",
        },
      });
      expect(burrowDepositFlow.isMatch(intent)).toBe(true);
    });

    it("does not match intent with different action", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "kamino-deposit",
          tokenId: "wrap.near",
        } as any,
      });
      expect(burrowDepositFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent without tokenId", () => {
      const intent = createBaseIntent({
        metadata: {
          action: "burrow-deposit",
        } as any,
      });
      expect(burrowDepositFlow.isMatch(intent)).toBe(false);
    });

    it("does not match intent without metadata", () => {
      const intent = createBaseIntent({ metadata: undefined });
      expect(burrowDepositFlow.isMatch(intent)).toBe(false);
    });
  });

  describe("validateMetadata", () => {
    it("accepts valid named account tokenId", () => {
      const metadata: BurrowDepositMetadata = {
        action: "burrow-deposit",
        tokenId: "wrap.near",
      };
      expect(() => burrowDepositFlow.validateMetadata!(metadata)).not.toThrow();
    });

    it("accepts valid implicit account tokenId (64 hex chars)", () => {
      const metadata: BurrowDepositMetadata = {
        action: "burrow-deposit",
        tokenId: "a".repeat(64),
      };
      expect(() => burrowDepositFlow.validateMetadata!(metadata)).not.toThrow();
    });

    it("strips nep141: prefix from tokenId", () => {
      const metadata: BurrowDepositMetadata = {
        action: "burrow-deposit",
        tokenId: "nep141:wrap.near",
      };
      burrowDepositFlow.validateMetadata!(metadata);
      expect(metadata.tokenId).toBe("wrap.near");
    });

    it("rejects invalid tokenId format", () => {
      const metadata: BurrowDepositMetadata = {
        action: "burrow-deposit",
        tokenId: "invalid",
      };
      expect(() => burrowDepositFlow.validateMetadata!(metadata)).toThrow(
        "Burrow deposit tokenId must be a valid NEAR contract address"
      );
    });
  });

  describe("validateAuthorization", () => {
    it("passes with valid userDestination", async () => {
      const intent = createBaseIntent({
        userDestination: "user.near",
        metadata: {
          action: "burrow-deposit",
          tokenId: "wrap.near",
        },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await expect(
        burrowDepositFlow.validateAuthorization!(intent as any, ctx)
      ).resolves.not.toThrow();
    });

    it("throws without userDestination", async () => {
      const intent = createBaseIntent({
        userDestination: undefined as any,
        metadata: {
          action: "burrow-deposit",
          tokenId: "wrap.near",
        },
      });
      const ctx = createMockFlowContext("test-intent-1");

      await expect(
        burrowDepositFlow.validateAuthorization!(intent as any, ctx)
      ).rejects.toThrow("Burrow deposit requires userDestination");
    });
  });

  describe("execute", () => {
    const depositIntent = createBaseIntent({
      metadata: {
        action: "burrow-deposit",
        tokenId: "wrap.near",
      },
    }) as ValidatedIntent & { metadata: BurrowDepositMetadata };

    beforeEach(async () => {
      const { deriveNearAgentAccount, ensureNearAccountFunded, executeNearFunctionCall } = await import("../utils/near");
      const { getAssetsPagedDetailed, buildSupplyTransaction } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockReset();
      vi.mocked(ensureNearAccountFunded).mockReset();
      vi.mocked(executeNearFunctionCall).mockReset();
      vi.mocked(getAssetsPagedDetailed).mockReset();
      vi.mocked(buildSupplyTransaction).mockReset();
    });

    it("returns dry-run result when dryRunSwaps is true", async () => {
      const ctx = createMockFlowContext("test-intent-1", {
        config: { dryRunSwaps: true } as any,
      });
      const result = await burrowDepositFlow.execute(depositIntent, ctx);
      expect(result.txId).toContain("dry-run");
    });

    it("throws when token is not supported by Burrow", async () => {
      const { deriveNearAgentAccount } = await import("../utils/near");
      const { getAssetsPagedDetailed } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent-account.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([]);

      const ctx = createMockFlowContext("test-intent-1");
      await expect(burrowDepositFlow.execute(depositIntent, ctx))
        .rejects.toThrow("Token wrap.near is not supported by Burrow");
    });

    it("throws when token cannot be deposited", async () => {
      const { deriveNearAgentAccount } = await import("../utils/near");
      const { getAssetsPagedDetailed } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent-account.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([
        { token_id: "wrap.near", config: { can_deposit: false, can_use_as_collateral: false } },
      ] as any);

      const ctx = createMockFlowContext("test-intent-1");
      await expect(burrowDepositFlow.execute(depositIntent, ctx))
        .rejects.toThrow("Token wrap.near cannot be deposited to Burrow");
    });

    it("throws when token cannot be used as collateral but isCollateral is true", async () => {
      const { deriveNearAgentAccount } = await import("../utils/near");
      const { getAssetsPagedDetailed } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent-account.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([
        { token_id: "wrap.near", config: { can_deposit: true, can_use_as_collateral: false } },
      ] as any);

      const collateralIntent = createBaseIntent({
        metadata: {
          action: "burrow-deposit",
          tokenId: "wrap.near",
          isCollateral: true,
        },
      }) as ValidatedIntent & { metadata: BurrowDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await expect(burrowDepositFlow.execute(collateralIntent, ctx))
        .rejects.toThrow("Token wrap.near cannot be used as collateral");
    });

    it("executes deposit successfully", async () => {
      const { deriveNearAgentAccount, executeNearFunctionCall } = await import("../utils/near");
      const { getAssetsPagedDetailed, buildSupplyTransaction } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent-account.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([
        { token_id: "wrap.near", config: { can_deposit: true, can_use_as_collateral: true } },
      ] as any);
      vi.mocked(buildSupplyTransaction).mockResolvedValue({
        contract_id: "contract.burrow.near",
        method_name: "ft_transfer_call",
        args: { amount: "100" },
      } as any);
      vi.mocked(executeNearFunctionCall).mockResolvedValue("tx-hash-123");

      const ctx = createMockFlowContext("test-intent-1");
      const result = await burrowDepositFlow.execute(depositIntent, ctx);

      expect(result.txId).toBe("tx-hash-123");
      expect(executeNearFunctionCall).toHaveBeenCalled();
    });

    it("uses intermediateAmount when available", async () => {
      const { deriveNearAgentAccount, executeNearFunctionCall } = await import("../utils/near");
      const { getAssetsPagedDetailed, buildSupplyTransaction } = await import("../utils/burrow");
      vi.mocked(deriveNearAgentAccount).mockResolvedValue({
        accountId: "agent-account.near",
        derivationPath: "near-1,user.near",
      } as any);
      vi.mocked(getAssetsPagedDetailed).mockResolvedValue([
        { token_id: "wrap.near", config: { can_deposit: true, can_use_as_collateral: false } },
      ] as any);
      vi.mocked(buildSupplyTransaction).mockResolvedValue({
        contract_id: "contract.burrow.near",
        method_name: "ft_transfer_call",
        args: {},
      } as any);
      vi.mocked(executeNearFunctionCall).mockResolvedValue("tx-hash-456");

      const intentWithIntermediate = createBaseIntent({
        intermediateAmount: "5000",
        metadata: {
          action: "burrow-deposit",
          tokenId: "wrap.near",
        },
      }) as ValidatedIntent & { metadata: BurrowDepositMetadata };

      const ctx = createMockFlowContext("test-intent-1");
      await burrowDepositFlow.execute(intentWithIntermediate, ctx);

      expect(buildSupplyTransaction).toHaveBeenCalledWith(expect.objectContaining({
        amount: "5000",
      }));
    });
  });
});
