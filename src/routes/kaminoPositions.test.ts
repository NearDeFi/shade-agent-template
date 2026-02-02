import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import kaminoPositionsApp from "./kaminoPositions";
import { PublicKey } from "@solana/web3.js";

const { deriveAgentPublicKeyMock, KaminoMarketMock } = vi.hoisted(() => ({
  deriveAgentPublicKeyMock: vi.fn(),
  KaminoMarketMock: {
    load: vi.fn(),
  },
}));

vi.mock("../utils/solana", () => ({
  deriveAgentPublicKey: deriveAgentPublicKeyMock,
  SOLANA_DEFAULT_PATH: "solana,1",
}));

vi.mock("@solana/kit", () => ({
  createSolanaRpc: vi.fn(() => ({})),
  address: vi.fn((addr) => addr),
}));

vi.mock("@kamino-finance/klend-sdk", () => ({
  KaminoMarket: KaminoMarketMock,
  PROGRAM_ID: "KLend2g3cP87ber4Y1ZJLsJbyJxYqEhJQMSP7YbMLLt",
}));

const app = new Hono().route("/api/kamino-positions", kaminoPositionsApp);

describe("kaminoPositions route", () => {
  beforeEach(() => {
    deriveAgentPublicKeyMock.mockReset();
    KaminoMarketMock.load.mockReset();
  });

  describe("GET /", () => {
    it("returns user address and instructions with userDestination", async () => {
      const mockPubkey = new PublicKey("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      deriveAgentPublicKeyMock.mockResolvedValue(mockPubkey);

      const res = await app.request("/api/kamino-positions?userDestination=user.near");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userAddress).toBe("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      expect(body.message).toContain("Use GET /:marketAddress");
    });

    it("derives address from userDestination when provided", async () => {
      const mockPubkey = new PublicKey("4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk");
      deriveAgentPublicKeyMock.mockResolvedValue(mockPubkey);

      const res = await app.request(
        "/api/kamino-positions?userDestination=user.near"
      );

      expect(res.status).toBe(200);
      expect(deriveAgentPublicKeyMock).toHaveBeenCalledWith(
        "solana,1",
        "user.near"
      );
    });

    it("returns 500 on derivation error", async () => {
      deriveAgentPublicKeyMock.mockRejectedValue(new Error("Invalid public key"));

      const res = await app.request("/api/kamino-positions?userDestination=user.near");

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Invalid public key");
    });
  });

  describe("GET /:marketAddress", () => {
    const marketAddress = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";

    it("returns positions for valid market and user", async () => {
      const mockPubkey = new PublicKey("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      deriveAgentPublicKeyMock.mockResolvedValue(mockPubkey);

      const mockReserve = {
        getLiquidityMint: () => "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        symbol: "USDC",
      };

      const mockObligation = {
        obligationAddress: "ObligationAddr111111111111111111111111111111",
        deposits: new Map([
          [
            "ReserveAddr111111111111111111111111111111111",
            {
              amount: BigInt(1000000),
              marketValueRefreshed: 1.0,
            },
          ],
        ]),
        borrows: new Map(),
        refreshedStats: {
          userTotalDeposit: 1.0,
          userTotalBorrow: 0,
          loanToValue: 0,
          liquidationLtv: 0.8,
        },
      };

      KaminoMarketMock.load.mockResolvedValue({
        getAllUserObligations: vi.fn().mockResolvedValue([mockObligation]),
        getReserveByAddress: vi.fn().mockReturnValue(mockReserve),
      });

      const res = await app.request(
        `/api/kamino-positions/${marketAddress}?userDestination=user.near`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userAddress).toBe("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      expect(body.marketAddress).toBe(marketAddress);
      expect(body.obligations).toHaveLength(1);
      expect(body.obligations[0].deposits).toHaveLength(1);
    });

    it("returns 404 when market not found", async () => {
      const mockPubkey = new PublicKey("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      deriveAgentPublicKeyMock.mockResolvedValue(mockPubkey);
      KaminoMarketMock.load.mockResolvedValue(null);

      const res = await app.request(
        `/api/kamino-positions/${marketAddress}?userDestination=user.near`
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("Market not found");
    });

    it("returns empty obligations when user has no positions", async () => {
      const mockPubkey = new PublicKey("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      deriveAgentPublicKeyMock.mockResolvedValue(mockPubkey);

      KaminoMarketMock.load.mockResolvedValue({
        getAllUserObligations: vi.fn().mockResolvedValue([]),
        getReserveByAddress: vi.fn(),
      });

      const res = await app.request(
        `/api/kamino-positions/${marketAddress}?userDestination=user.near`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.obligations).toHaveLength(0);
    });

    it("returns 500 on market load error", async () => {
      const mockPubkey = new PublicKey("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      deriveAgentPublicKeyMock.mockResolvedValue(mockPubkey);
      KaminoMarketMock.load.mockRejectedValue(new Error("RPC timeout"));

      const res = await app.request(
        `/api/kamino-positions/${marketAddress}?userDestination=user.near`
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("RPC timeout");
    });

    it("handles positions with both deposits and borrows", async () => {
      const mockPubkey = new PublicKey("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      deriveAgentPublicKeyMock.mockResolvedValue(mockPubkey);

      const mockReserve = {
        getLiquidityMint: () => "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        symbol: "USDC",
      };

      const mockObligation = {
        obligationAddress: "ObligationAddr111111111111111111111111111111",
        deposits: new Map([
          [
            "DepositReserve11111111111111111111111111111",
            {
              amount: BigInt(2000000),
              marketValueRefreshed: 2.0,
            },
          ],
        ]),
        borrows: new Map([
          [
            "BorrowReserve111111111111111111111111111111",
            {
              amount: BigInt(500000),
              marketValueRefreshed: 0.5,
            },
          ],
        ]),
        refreshedStats: {
          userTotalDeposit: 2.0,
          userTotalBorrow: 0.5,
          loanToValue: 0.25,
          liquidationLtv: 0.8,
        },
      };

      KaminoMarketMock.load.mockResolvedValue({
        getAllUserObligations: vi.fn().mockResolvedValue([mockObligation]),
        getReserveByAddress: vi.fn().mockReturnValue(mockReserve),
      });

      const res = await app.request(
        `/api/kamino-positions/${marketAddress}?userDestination=user.near`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.obligations[0].deposits).toHaveLength(1);
      expect(body.obligations[0].borrows).toHaveLength(1);
      expect(body.obligations[0].totalDepositedUsd).toBe("2");
      expect(body.obligations[0].totalBorrowedUsd).toBe("0.5");
      expect(body.obligations[0].ltv).toBe("0.25");
    });

    it("handles unknown reserve gracefully", async () => {
      const mockPubkey = new PublicKey("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      deriveAgentPublicKeyMock.mockResolvedValue(mockPubkey);

      const mockObligation = {
        obligationAddress: "ObligationAddr111111111111111111111111111111",
        deposits: new Map([
          [
            "UnknownReserve1111111111111111111111111111",
            {
              amount: BigInt(1000000),
              marketValueRefreshed: 1.0,
            },
          ],
        ]),
        borrows: new Map(),
        refreshedStats: {
          userTotalDeposit: 1.0,
          userTotalBorrow: 0,
          loanToValue: 0,
          liquidationLtv: 0.8,
        },
      };

      KaminoMarketMock.load.mockResolvedValue({
        getAllUserObligations: vi.fn().mockResolvedValue([mockObligation]),
        getReserveByAddress: vi.fn().mockReturnValue(null), // Reserve not found
      });

      const res = await app.request(
        `/api/kamino-positions/${marketAddress}?userDestination=user.near`
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.obligations[0].deposits[0].mintAddress).toBe("unknown");
      expect(body.obligations[0].deposits[0].symbol).toBe("unknown");
    });
  });
});
