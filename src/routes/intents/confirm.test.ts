import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { config } from "../../config";
import confirmApp from "./confirm";

// Native mint address as a plain string (Kit's Address is just a branded string)
const NATIVE_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

// Pre-computed ATA for the agent owner + native mint.
// In the Kit world, findAssociatedTokenPda is async, but in the confirm service
// we call it with specific inputs. We need to know what the ATA will be so we can
// match it in our mock transaction. We'll just use a deterministic fake ATA string.
const AGENT_WSOL_ATA = "AgentWsolAta111111111111111111111111111111111";

const mocks = vi.hoisted(() => ({
  validateIntentMock: vi.fn(),
  getStatusMock: vi.fn(),
  setStatusMock: vi.fn(),
  enqueueIntentWithStatusMock: vi.fn(),
  transitionStatusMock: vi.fn(),
  enqueueIntentMock: vi.fn(),
  deriveAgentPublicKeyMock: vi.fn(),
  getSolanaRpcMock: vi.fn(),
  deriveNearAgentAccountMock: vi.fn(),
  getNearTransactionStatusMock: vi.fn(),
  findAssociatedTokenPdaMock: vi.fn(),
}));

// Prevent @ref-finance/ref-sdk from requiring 'react' at import time
vi.mock("@ref-finance/ref-sdk", () => ({
  init_env: vi.fn(),
  ftGetTokenMetadata: vi.fn(),
  fetchAllPools: vi.fn(),
  estimateSwap: vi.fn(),
  instantSwap: vi.fn(),
}));

vi.mock("../../queue/validation", () => ({
  validateIntent: mocks.validateIntentMock,
}));

vi.mock("../../state/status", () => ({
  getStatus: mocks.getStatusMock,
  setStatus: mocks.setStatusMock,
  enqueueIntentWithStatus: mocks.enqueueIntentWithStatusMock,
  transitionStatus: mocks.transitionStatusMock,
}));

vi.mock("../../queue/client", () => ({
  queueClient: {
    enqueueIntent: mocks.enqueueIntentMock,
  },
}));

vi.mock("../../utils/solana", () => ({
  deriveAgentPublicKey: mocks.deriveAgentPublicKeyMock,
  getSolanaRpc: mocks.getSolanaRpcMock,
}));

vi.mock("@solana-program/token", () => ({
  findAssociatedTokenPda: mocks.findAssociatedTokenPdaMock,
  TOKEN_PROGRAM_ADDRESS: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
}));

vi.mock("../../utils/near", () => ({
  deriveNearAgentAccount: mocks.deriveNearAgentAccountMock,
  getNearTransactionStatus: mocks.getNearTransactionStatusMock,
}));

const app = new Hono().route("/api/intents", confirmApp);

function buildTxResponse({
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
  // Kit RPC getTransaction with jsonParsed encoding returns account keys as
  // an array of objects with `pubkey` field or plain strings.
  const accountKeys: string[] = [signer, "11111111111111111111111111111111"];
  if (includeAgentAta) {
    accountKeys.push(agentWsolAta);
  }

  return {
    transaction: {
      message: {
        accountKeys,
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
      },
    },
    meta: {
      err: null,
      preTokenBalances: includeAgentAta
        ? [
            {
              accountIndex: 2,
              mint: NATIVE_MINT_ADDRESS,
              uiTokenAmount: { amount: preAmount, decimals: 9, uiAmount: null, uiAmountString: preAmount },
            },
          ]
        : [],
      postTokenBalances: includeAgentAta
        ? [
            {
              accountIndex: 2,
              mint: NATIVE_MINT_ADDRESS,
              uiTokenAmount: { amount: postAmount, decimals: 9, uiAmount: null, uiAmountString: postAmount },
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
    mocks.enqueueIntentWithStatusMock.mockReset();
    mocks.transitionStatusMock.mockReset();
    mocks.enqueueIntentMock.mockReset();
    mocks.deriveAgentPublicKeyMock.mockReset();
    mocks.getSolanaRpcMock.mockReset();
    mocks.deriveNearAgentAccountMock.mockReset();
    mocks.getNearTransactionStatusMock.mockReset();
    mocks.findAssociatedTokenPdaMock.mockReset();

    mocks.enqueueIntentWithStatusMock.mockImplementation(async (intent: { intentId: string }, status: unknown) => {
      await mocks.enqueueIntentMock(intent);
      await mocks.setStatusMock(intent.intentId, status);
    });

    mocks.validateIntentMock.mockImplementation((intent) => intent);
    mocks.transitionStatusMock.mockResolvedValue({
      updated: true,
      currentStatus: { state: "processing" },
    });
    // deriveAgentPublicKey now returns Address (plain string)
    mocks.deriveAgentPublicKeyMock.mockResolvedValue(agentOwner);
    // findAssociatedTokenPda returns [ata, bump] — mock returns our deterministic ATA
    mocks.findAssociatedTokenPdaMock.mockResolvedValue([AGENT_WSOL_ATA, 255]);
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
    mocks.getSolanaRpcMock.mockReturnValue({
      getTransaction: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(
          buildTxResponse({
            signer: otherSigner,
            agentWsolAta: AGENT_WSOL_ATA,
            preAmount: "0",
            postAmount: "100",
          }),
        ),
      }),
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
    mocks.getSolanaRpcMock.mockReturnValue({
      getTransaction: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(
          buildTxResponse({
            signer: userSourceAddress,
            agentWsolAta: AGENT_WSOL_ATA,
            preAmount: "100",
            postAmount: "100",
          }),
        ),
      }),
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
    mocks.getSolanaRpcMock.mockReturnValue({
      getTransaction: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(
          buildTxResponse({
            signer: userSourceAddress,
            agentWsolAta: AGENT_WSOL_ATA,
            preAmount: "10",
            postAmount: "110",
          }),
        ),
      }),
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
    expect(mocks.getSolanaRpcMock).not.toHaveBeenCalled();
  });
});
