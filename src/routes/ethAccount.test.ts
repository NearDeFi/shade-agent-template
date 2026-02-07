import { describe, expect, it, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import ethAccountApp from "./ethAccount";

const { deriveAddressAndPublicKeyMock, getBalanceMock } = vi.hoisted(() => ({
  deriveAddressAndPublicKeyMock: vi.fn(),
  getBalanceMock: vi.fn(),
}));

vi.mock("../utils/ethereum", () => ({
  Evm: {
    deriveAddressAndPublicKey: deriveAddressAndPublicKeyMock,
    getBalance: getBalanceMock,
  },
}));

const app = new Hono().route("/api/eth-account", ethAccountApp);

describe("ethAccount route", () => {
  beforeEach(() => {
    deriveAddressAndPublicKeyMock.mockReset();
    getBalanceMock.mockReset();
    process.env.NEXT_PUBLIC_contractId = "contract.test";
  });

  it("fails when contract id missing", async () => {
    delete process.env.NEXT_PUBLIC_contractId;
    const res = await app.request("/api/eth-account");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Contract ID/);
  });

  it("returns derived address and balance", async () => {
    deriveAddressAndPublicKeyMock.mockResolvedValue({ address: "0xabc" });
    getBalanceMock.mockResolvedValue({ balance: "123" });

    const res = await app.request("/api/eth-account");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.senderAddress).toBe("0xabc");
    expect(body.balance).toBe("123");
  });
});
