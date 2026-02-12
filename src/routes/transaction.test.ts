import { describe, expect, it, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import transactionApp from "./transaction";

const mocks = vi.hoisted(() => {
  return {
    requestSignatureMock: vi.fn(),
    deriveAddressAndPublicKeyMock: vi.fn(),
    prepareTransactionForSigningMock: vi.fn(),
    finalizeTransactionSigningMock: vi.fn(),
    broadcastTxMock: vi.fn(),
    getEthereumPriceUSDMock: vi.fn(),
    toRSVMock: vi.fn(),
  };
});

vi.mock("@neardefi/shade-agent-js", () => ({
  requestSignature: mocks.requestSignatureMock,
}));

vi.mock("../utils/fetch-eth-price", () => ({
  getEthereumPriceUSD: mocks.getEthereumPriceUSDMock,
}));

vi.mock("../utils/ethereum", () => ({
  ethContractAbi: [],
  ethContractAddress: "0xprice",
  ethRpcUrl: "http://rpc",
  Evm: {
    deriveAddressAndPublicKey: mocks.deriveAddressAndPublicKeyMock,
    prepareTransactionForSigning: mocks.prepareTransactionForSigningMock,
    finalizeTransactionSigning: mocks.finalizeTransactionSigningMock,
    broadcastTx: mocks.broadcastTxMock,
  },
}));

vi.mock("chainsig.js", () => ({
  utils: {
    cryptography: {
      toRSV: mocks.toRSVMock,
      uint8ArrayToHex: () => "hexpayload",
    },
  },
}));

vi.mock("ethers", () => {
  class DummyContract {
    interface = {
      encodeFunctionData: () => "0xdata",
    };
    constructor() {}
  }
  class DummyProvider {}
  return { Contract: DummyContract, JsonRpcProvider: DummyProvider };
});

const app = new Hono().route("/api/transaction", transactionApp);

describe("transaction route", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_contractId = "contract.test";
    mocks.requestSignatureMock.mockReset();
    mocks.deriveAddressAndPublicKeyMock.mockReset();
    mocks.prepareTransactionForSigningMock.mockReset();
    mocks.finalizeTransactionSigningMock.mockReset();
    mocks.broadcastTxMock.mockReset();
    mocks.getEthereumPriceUSDMock.mockReset();
    mocks.toRSVMock.mockReset();

    mocks.getEthereumPriceUSDMock.mockResolvedValue(12345);
    mocks.deriveAddressAndPublicKeyMock.mockResolvedValue({ address: "0xabc" });
    mocks.prepareTransactionForSigningMock.mockResolvedValue({
      transaction: { foo: "tx" },
      hashesToSign: [new Uint8Array([1, 2])],
    });
    mocks.requestSignatureMock.mockResolvedValue({ signature: "sig" });
    mocks.toRSVMock.mockReturnValue("rsvsig");
    mocks.finalizeTransactionSigningMock.mockReturnValue({ signed: true });
    mocks.broadcastTxMock.mockResolvedValue({ hash: "0xhash" });
  });

  it("returns tx hash and price when successful", async () => {
    const res = await app.request("/api/transaction", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.txHash).toBe("0xhash");
    expect(body.newPrice).toBe("123.45");
    expect(mocks.getEthereumPriceUSDMock).toHaveBeenCalled();
    expect(mocks.broadcastTxMock).toHaveBeenCalled();
  });

  it("fails when price fetch returns null", async () => {
    mocks.getEthereumPriceUSDMock.mockResolvedValue(null);
    const res = await app.request("/api/transaction", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/fetch ETH price/i);
  });

  it("fails when contract id is missing", async () => {
    delete process.env.NEXT_PUBLIC_contractId;
    const res = await app.request("/api/transaction", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Contract ID/);
  });

  it("fails when signing fails", async () => {
    mocks.requestSignatureMock.mockRejectedValue(new Error("signing error"));
    const res = await app.request("/api/transaction", { method: "POST" });
    expect(res.status).toBe(500);
  });

  it("fails when broadcast fails", async () => {
    mocks.broadcastTxMock.mockRejectedValue(new Error("broadcast error"));
    const res = await app.request("/api/transaction", { method: "POST" });
    expect(res.status).toBe(500);
  });
});
