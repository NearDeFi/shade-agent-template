import { describe, expect, it, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import chainsigTestApp from "./chainsigTest";

const mocks = vi.hoisted(() => ({
  deriveAgentPublicKeyMock: vi.fn(),
  getSolanaRpcMock: vi.fn(),
  buildAndCompileTransactionMock: vi.fn(),
  parseSignatureMock: vi.fn(),
  requestSignatureMock: vi.fn(),
}));

vi.mock("../utils/solana", () => ({
  deriveAgentPublicKey: mocks.deriveAgentPublicKeyMock,
  getSolanaRpc: mocks.getSolanaRpcMock,
  buildAndCompileTransaction: mocks.buildAndCompileTransactionMock,
  SOLANA_DEFAULT_PATH: "solana-1",
}));

vi.mock("@solana-program/system", () => ({
  getTransferSolInstruction: vi.fn().mockReturnValue({
    programAddress: "11111111111111111111111111111111",
    accounts: [],
    data: new Uint8Array(0),
  }),
}));

vi.mock("../utils/signature", () => ({
  parseSignature: mocks.parseSignatureMock,
}));

vi.mock("@neardefi/shade-agent-js", () => ({
  requestSignature: mocks.requestSignatureMock,
}));

const app = new Hono().route("/api/chainsig-test", chainsigTestApp);

describe("chainsig-test route", () => {
  beforeEach(() => {
    mocks.deriveAgentPublicKeyMock.mockReset();
    mocks.getSolanaRpcMock.mockReset();
    mocks.buildAndCompileTransactionMock.mockReset();
    mocks.parseSignatureMock.mockReset();
    mocks.requestSignatureMock.mockReset();

    // deriveAgentPublicKey returns Address (plain string)
    mocks.deriveAgentPublicKeyMock.mockResolvedValue("agent-pubkey");
    mocks.getSolanaRpcMock.mockReturnValue({});
    mocks.buildAndCompileTransactionMock.mockResolvedValue({
      messageBytes: new Uint8Array([1, 2, 3]),
      signatures: { "agent-pubkey": new Uint8Array(64) },
    });
    mocks.requestSignatureMock.mockResolvedValue({ signature: "sig" });
    mocks.parseSignatureMock.mockReturnValue(new Uint8Array(64));
  });

  it("returns signed payload metadata", async () => {
    const res = await app.request("/api/chainsig-test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentPublicKey).toBe("agent-pubkey");
    expect(body.status).toBe("signed");
    expect(body.signatureHex).toBeDefined();
  });

  it("handles missing signature", async () => {
    mocks.requestSignatureMock.mockResolvedValue({});
    const res = await app.request("/api/chainsig-test");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/No signature/);
  });

  it("handles unsupported signature encoding", async () => {
    mocks.parseSignatureMock.mockReturnValue(null);
    const res = await app.request("/api/chainsig-test");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Unsupported signature/);
  });

  it("handles derivation error", async () => {
    mocks.deriveAgentPublicKeyMock.mockRejectedValue(new Error("derivation failed"));
    const res = await app.request("/api/chainsig-test");
    expect(res.status).toBe(500);
  });

  it("handles build transaction error", async () => {
    mocks.buildAndCompileTransactionMock.mockRejectedValue(new Error("build failed"));
    const res = await app.request("/api/chainsig-test");
    expect(res.status).toBe(500);
  });
});
