import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { config } from "../../config";
import confirmApp from "./confirm";

  const mocks = vi.hoisted(() => ({
    validateIntentMock: vi.fn(),
    getStatusMock: vi.fn(),
    setStatusMock: vi.fn(),
    transitionStatusMock: vi.fn(),
    enqueueIntentMock: vi.fn(),
    deriveAgentPublicKeyMock: vi.fn(),
    getSolanaConnectionMock: vi.fn(),
    deriveNearAgentAccountMock: vi.fn(),
  getNearTransactionStatusMock: vi.fn(),
}));

vi.mock("../../queue/validation", () => ({
  validateIntent: mocks.validateIntentMock,
}));

vi.mock("../../state/status", () => ({
  getStatus: mocks.getStatusMock,
  setStatus: mocks.setStatusMock,
  transitionStatus: mocks.transitionStatusMock,
}));

vi.mock("../../queue/client", () => ({
  queueClient: {
    enqueueIntent: mocks.enqueueIntentMock,
  },
}));

vi.mock("../../utils/solana", () => ({
  deriveAgentPublicKey: mocks.deriveAgentPublicKeyMock,
  getSolanaConnection: mocks.getSolanaConnectionMock,
}));

vi.mock("../../utils/near", () => ({
  deriveNearAgentAccount: mocks.deriveNearAgentAccountMock,
  getNearTransactionStatus: mocks.getNearTransactionStatusMock,
}));

const app = new Hono().route("/api/intents", confirmApp);

function buildTxInfo({
  signer,
  agentWsolAta,
  preAmount,
  postAmount,
  includeAgentAta = true,
}: {
  signer: string;
  agentWsolAta: string;
  preAmount: string;
  postAmount: string;
  includeAgentAta?: boolean;
}) {
  const staticKeys: PublicKey[] = [new PublicKey(signer)];
  staticKeys.push(new PublicKey("11111111111111111111111111111111"));
  if (includeAgentAta) {
    staticKeys.push(new PublicKey(agentWsolAta));
  }

  return {
    transaction: {
      message: {
        header: { numRequiredSignatures: 1 },
        getAccountKeys: () => ({
          length: staticKeys.length,
          get: (idx: number) => staticKeys[idx],
        }),
      },
    },
    meta: {
      err: null,
      preTokenBalances: includeAgentAta
        ? [
            {
              accountIndex: 2,
              mint: NATIVE_MINT.toBase58(),
              uiTokenAmount: { amount: preAmount },
            },
          ]
        : [],
      postTokenBalances: includeAgentAta
        ? [
            {
              accountIndex: 2,
              mint: NATIVE_MINT.toBase58(),
              uiTokenAmount: { amount: postAmount },
            },
          ]
        : [],
    },
  };
}

describe("intents confirm route (solana security)", () => {
  const userSourceAddress = "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk";
  const otherSigner = "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u";
  const agentOwner = "9xQeWvG816bUx9EPjHmaT23yvVMvP4fF2f7u1x9A4mb";

  beforeEach(() => {
    config.enableQueue = true;
    mocks.validateIntentMock.mockReset();
    mocks.getStatusMock.mockReset();
    mocks.setStatusMock.mockReset();
    mocks.transitionStatusMock.mockReset();
    mocks.enqueueIntentMock.mockReset();
    mocks.deriveAgentPublicKeyMock.mockReset();
    mocks.getSolanaConnectionMock.mockReset();
    mocks.deriveNearAgentAccountMock.mockReset();
    mocks.getNearTransactionStatusMock.mockReset();

    mocks.validateIntentMock.mockImplementation((intent) => intent);
    mocks.transitionStatusMock.mockResolvedValue({
      updated: true,
      currentStatus: { state: "processing" },
    });
    mocks.deriveAgentPublicKeyMock.mockResolvedValue(new PublicKey(agentOwner));
    mocks.getStatusMock.mockResolvedValue({
      state: "awaiting_user_tx",
      intentData: {
        intentId: "intent-1",
        sourceChain: "solana",
        sourceAsset: "1cs_v1:sol:native",
        sourceAmount: "1000",
        destinationChain: "near",
        finalAsset: "nep141:wrap.near",
        userDestination: userSourceAddress,
        agentDestination: agentOwner,
        metadata: {
          action: "sol-bridge-out",
          userSourceAddress,
          destinationChain: "near",
          destinationAddress: "alice.near",
          destinationAsset: "nep141:wrap.near",
        },
      },
    });
  });

  it("rejects when expected user source is not a signer", async () => {
    const agentWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      new PublicKey(agentOwner),
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58();

    mocks.getSolanaConnectionMock.mockReturnValue({
      getTransaction: vi.fn().mockResolvedValue(
        buildTxInfo({
          signer: otherSigner,
          agentWsolAta,
          preAmount: "0",
          postAmount: "100",
        }),
      ),
    });

    const res = await app.request("/api/intents/intent-1/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: "tx-1" }),
    });

    expect(res.status).toBe(403);
    expect(mocks.enqueueIntentMock).not.toHaveBeenCalled();
    expect(mocks.transitionStatusMock).toHaveBeenCalledWith(
      "intent-1",
      "processing",
      expect.objectContaining({ state: "awaiting_user_tx" }),
    );
  });

  it("rejects when agent wSOL ATA is not credited", async () => {
    const agentWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      new PublicKey(agentOwner),
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58();

    mocks.getSolanaConnectionMock.mockReturnValue({
      getTransaction: vi.fn().mockResolvedValue(
        buildTxInfo({
          signer: userSourceAddress,
          agentWsolAta,
          preAmount: "100",
          postAmount: "100",
        }),
      ),
    });

    const res = await app.request("/api/intents/intent-1/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: "tx-2" }),
    });

    expect(res.status).toBe(403);
    expect(mocks.enqueueIntentMock).not.toHaveBeenCalled();
    expect(mocks.transitionStatusMock).toHaveBeenCalledWith(
      "intent-1",
      "processing",
      expect.objectContaining({ state: "awaiting_user_tx" }),
    );
  });

  it("accepts and enqueues when signer and wSOL inflow checks pass", async () => {
    const agentWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      new PublicKey(agentOwner),
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58();

    mocks.getSolanaConnectionMock.mockReturnValue({
      getTransaction: vi.fn().mockResolvedValue(
        buildTxInfo({
          signer: userSourceAddress,
          agentWsolAta,
          preAmount: "10",
          postAmount: "110",
        }),
      ),
    });

    const res = await app.request("/api/intents/intent-1/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: "tx-3" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.enqueueIntentMock).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when confirm lock cannot be acquired", async () => {
    mocks.transitionStatusMock.mockResolvedValueOnce({
      updated: false,
      currentStatus: { state: "processing" },
    });

    const res = await app.request("/api/intents/intent-1/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: "tx-4" }),
    });

    expect(res.status).toBe(409);
    expect(mocks.enqueueIntentMock).not.toHaveBeenCalled();
    expect(mocks.getSolanaConnectionMock).not.toHaveBeenCalled();
  });
});
