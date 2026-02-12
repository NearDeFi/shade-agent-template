import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import solAccountApp from "./solAccount";

const { deriveAgentPublicKeyMock, getBalanceMock } = vi.hoisted(() => ({
  deriveAgentPublicKeyMock: vi.fn(),
  getBalanceMock: vi.fn(),
}));

vi.mock("../utils/solana", () => ({
  deriveAgentPublicKey: deriveAgentPublicKeyMock,
  SOLANA_DEFAULT_PATH: "solana,1",
  SolanaAdapter: {
    getBalance: getBalanceMock,
  },
}));

const app = new Hono().route("/api/sol-account", solAccountApp);

describe("solAccount route", () => {
  beforeEach(() => {
    deriveAgentPublicKeyMock.mockReset();
    getBalanceMock.mockReset();
  });

  describe("GET /", () => {
    it("returns account info with default path", async () => {
      // deriveAgentPublicKey now returns Address (plain string)
      deriveAgentPublicKeyMock.mockResolvedValue("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      getBalanceMock.mockResolvedValue({
        balance: BigInt(5000000000), // 5 SOL in lamports
        decimals: 9,
      });

      const res = await app.request("/api/sol-account");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.address).toBe("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      expect(body.path).toBe("solana,1");
      expect(body.balanceLamports).toBe("5000000000");
      expect(body.balanceSol).toBe(5);
      expect(deriveAgentPublicKeyMock).toHaveBeenCalledWith("solana,1");
    });

    it("accepts custom path parameter", async () => {
      deriveAgentPublicKeyMock.mockResolvedValue("4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk");
      getBalanceMock.mockResolvedValue({
        balance: BigInt(1000000000),
        decimals: 9,
      });

      const res = await app.request("/api/sol-account?path=solana,2");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.path).toBe("solana,2");
      expect(deriveAgentPublicKeyMock).toHaveBeenCalledWith("solana,2");
    });

    it("returns correct balance calculation for fractional SOL", async () => {
      deriveAgentPublicKeyMock.mockResolvedValue("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      getBalanceMock.mockResolvedValue({
        balance: BigInt(1500000000), // 1.5 SOL
        decimals: 9,
      });

      const res = await app.request("/api/sol-account");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balanceLamports).toBe("1500000000");
      expect(body.balanceSol).toBe(1.5);
    });

    it("handles zero balance", async () => {
      deriveAgentPublicKeyMock.mockResolvedValue("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      getBalanceMock.mockResolvedValue({
        balance: BigInt(0),
        decimals: 9,
      });

      const res = await app.request("/api/sol-account");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balanceLamports).toBe("0");
      expect(body.balanceSol).toBe(0);
    });

    it("returns 500 on deriveAgentPublicKey error", async () => {
      deriveAgentPublicKeyMock.mockRejectedValue(new Error("Derivation failed"));

      const res = await app.request("/api/sol-account");

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Derivation failed");
    });

    it("returns 500 on getBalance error", async () => {
      deriveAgentPublicKeyMock.mockResolvedValue("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      getBalanceMock.mockRejectedValue(new Error("RPC connection failed"));

      const res = await app.request("/api/sol-account");

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("RPC connection failed");
    });

    it("handles large balance values", async () => {
      deriveAgentPublicKeyMock.mockResolvedValue("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u");
      // 1 billion SOL in lamports
      getBalanceMock.mockResolvedValue({
        balance: BigInt("1000000000000000000"),
        decimals: 9,
      });

      const res = await app.request("/api/sol-account");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.balanceLamports).toBe("1000000000000000000");
      expect(body.balanceSol).toBe(1000000000);
    });
  });
});
