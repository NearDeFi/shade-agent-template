import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import transactionRoute from "./routes/transaction";
import intentsRoute from "./routes/intents";
import agentAccountRoute from "./routes/agentAccount";
import chainsigTestRoute from "./routes/chainsigTest";
import statusRoute from "./routes/status";
import { config } from "./config";

const mocks = vi.hoisted(() => {
  const intentStatuses = new Map<string, unknown>();
  const enqueueIntentMock = vi.fn();
  const setStatusMock = vi.fn((id: string, status: unknown) =>
    intentStatuses.set(id, status),
  );
  const enqueueIntentWithStatusMock = vi.fn((intent: { intentId: string }, status: unknown) => {
    enqueueIntentMock(intent);
    return setStatusMock(intent.intentId, status);
  });
  return {
    requestSignatureMock: vi.fn(),
    deriveAddressAndPublicKeyMock: vi.fn(),
    prepareTransactionForSigningMock: vi.fn(),
    finalizeTransactionSigningMock: vi.fn(),
    broadcastTxMock: vi.fn(),
    deriveAgentPublicKeyMock: vi.fn(),
    getSolanaConnectionMock: vi.fn(),
    parseSignatureMock: vi.fn(),
    enqueueIntentMock,
    setStatusMock,
    enqueueIntentWithStatusMock,
    getStatusMock: vi.fn((id: string) =>
      Promise.resolve((intentStatuses.get(id) as any) || null),
    ),
    agentAccountIdMock: vi.fn(),
    agentMock: vi.fn(),
    intentStatuses,
  };
});

const originals = vi.hoisted(() => ({
  fetch: globalThis.fetch,
}));

// Prevent @ref-finance/ref-sdk from requiring 'react' at import time
vi.mock("@ref-finance/ref-sdk", () => ({
  init_env: vi.fn(),
  ftGetTokenMetadata: vi.fn(),
  fetchAllPools: vi.fn(),
  estimateSwap: vi.fn(),
  instantSwap: vi.fn(),
}));

vi.mock("@neardefi/shade-agent-js", () => ({
  requestSignature: mocks.requestSignatureMock,
  agentAccountId: mocks.agentAccountIdMock,
  agent: mocks.agentMock,
}));

vi.mock("./utils/ethereum", () => ({
  ethContractAbi: [
    {
      inputs: [{ name: "_price", type: "uint256" }],
      name: "updatePrice",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    },
  ],
  ethContractAddress: "0xprice",
  ethRpcUrl: "http://rpc",
  Evm: {
    deriveAddressAndPublicKey: mocks.deriveAddressAndPublicKeyMock,
    prepareTransactionForSigning: mocks.prepareTransactionForSigningMock,
    finalizeTransactionSigning: mocks.finalizeTransactionSigningMock,
    broadcastTx: mocks.broadcastTxMock,
  },
}));

vi.mock("./utils/solana", () => ({
  deriveAgentPublicKey: mocks.deriveAgentPublicKeyMock,
  getSolanaRpc: mocks.getSolanaConnectionMock,
  getSolanaConnection: mocks.getSolanaConnectionMock,
  buildAndCompileTransaction: vi.fn().mockResolvedValue({
    messageBytes: new Uint8Array([1, 2, 3]),
    signatures: { "agent-pubkey": new Uint8Array(64) },
  }),
  SOLANA_DEFAULT_PATH: "solana-1",
  attachSignatureToCompiledTx: (tx: any, _sig: any) => tx,
  broadcastSolanaTx: vi.fn().mockResolvedValue("txid"),
}));

vi.mock("./utils/signature", () => ({
  parseSignature: mocks.parseSignatureMock,
}));

vi.mock("./queue/redis", () => ({
  RedisQueueClient: vi.fn().mockImplementation(() => ({
    enqueueIntent: mocks.enqueueIntentMock,
  })),
}));

vi.mock("./state/status", () => ({
  setStatus: mocks.setStatusMock,
  enqueueIntentWithStatus: mocks.enqueueIntentWithStatusMock,
  getStatus: mocks.getStatusMock,
}));

vi.mock("chainsig.js", () => ({
  contracts: {
    ChainSignatureContract: class {
      constructor(_args: unknown) {}
      getDerivedPublicKey() {
        return "ed25519:11111111111111111111111111111111";
      }
    },
  },
  chainAdapters: {
    near: {
      NEAR: class {
        constructor(_args: unknown) {}
      },
    },
    solana: {
      Solana: class {
        constructor(_args: unknown) {}
      },
    },
  },
  utils: {
    cryptography: {
      toRSV: vi.fn().mockReturnValue("rsvsig"),
      uint8ArrayToHex: () => "hexpayload",
    },
  },
}));

vi.mock("@solana-program/system", () => ({
  getTransferSolInstruction: vi.fn().mockReturnValue({
    programAddress: "11111111111111111111111111111111",
    accounts: [],
    data: new Uint8Array(0),
  }),
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

const app = new Hono()
  .route("/api/transaction", transactionRoute)
  .route("/api/intents", intentsRoute)
  .route("/api/agent-account", agentAccountRoute)
  .route("/api/chainsig-test", chainsigTestRoute)
  .route("/api/status", statusRoute);

describe("integration: API routes", () => {
  beforeEach(() => {
    mocks.intentStatuses.clear();
    mocks.requestSignatureMock.mockReset();
    mocks.agentAccountIdMock.mockReset();
    mocks.agentMock.mockReset();
    mocks.deriveAddressAndPublicKeyMock.mockReset();
    mocks.prepareTransactionForSigningMock.mockReset();
    mocks.finalizeTransactionSigningMock.mockReset();
    mocks.broadcastTxMock.mockReset();
    mocks.enqueueIntentMock.mockReset();
    mocks.parseSignatureMock.mockReset();
    mocks.deriveAgentPublicKeyMock.mockReset();
    mocks.getSolanaConnectionMock.mockReset();

    process.env.NEXT_PUBLIC_contractId = "contract.test";
    config.enableQueue = true;
    config.dryRunSwaps = true;

    // Price fetch mocks
    mocks.agentAccountIdMock.mockResolvedValue({ accountId: "agent.test" });
    mocks.agentMock.mockResolvedValue({ balance: "10" });
    mocks.getStatusMock.mockImplementation((id: string) =>
      Promise.resolve((mocks.intentStatuses.get(id) as any) || null),
    );

    mocks.requestSignatureMock.mockResolvedValue({ signature: "sig" });
    mocks.deriveAddressAndPublicKeyMock.mockResolvedValue({ address: "0xabc" });
    mocks.prepareTransactionForSigningMock.mockResolvedValue({
      transaction: { foo: "tx" },
      hashesToSign: [new Uint8Array([1, 2])],
    });
    mocks.finalizeTransactionSigningMock.mockReturnValue({ signed: true });
    mocks.broadcastTxMock.mockResolvedValue({ hash: "0xhash" });
    mocks.parseSignatureMock.mockReturnValue(new Uint8Array(64));
    // deriveAgentPublicKey returns Address (plain string)
    mocks.deriveAgentPublicKeyMock.mockResolvedValue("agent-pubkey");
    mocks.getSolanaConnectionMock.mockReturnValue({});
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("okx.com")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: [{ last: "123.45" }] }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("coinbase.com")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { amount: "123.55" } }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/quote")) {
        return Promise.resolve(
          new Response(JSON.stringify({ swapMode: "ExactIn" }), { status: 200 }),
        );
      }
      if (url.includes("/swap")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ swapTransaction: Buffer.from([1, 2, 3]).toString("base64") }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originals.fetch;
  });

  it("handles transaction request end-to-end with mocks", async () => {
    const res = await app.request("/api/transaction", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.txHash).toBe("0xhash");
    expect(body.newPrice).toBeDefined();
    expect(mocks.broadcastTxMock).toHaveBeenCalled();
  });

  it("enqueues intent and exposes status", async () => {
    const intent = {
      intentId: "intent-1",
      sourceChain: "solana",
      destinationChain: "solana",
      sourceAsset: "So11111111111111111111111111111111111111111",
      intermediateAsset: "So11111111111111111111111111111111111111111",
      finalAsset: "So11111111111111111111111111111111111111111",
      sourceAmount: "1000",
      destinationAmount: "1000",
      userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
      agentDestination: "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
      // Required verification proof (deposit-verified)
      originTxHash: "test-tx-hash-12345",
      intentsDepositAddress: "deposit-addr-12345",
    };

    const postRes = await app.request("/api/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intent),
    });
    expect(postRes.status).toBe(202);
    expect(mocks.enqueueIntentMock).toHaveBeenCalled();

    const statusRes = await app.request("/api/status/intent-1");
    expect(statusRes.status).toBe(200);
    const body = await statusRes.json();
    expect(body.state).toBe("pending");
  });
});
