import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { handleNearSellQuote, handleSellQuote } from "./sell";

const mocks = vi.hoisted(() => ({
  fetchWithRetryMock: vi.fn(),
  setStatusMock: vi.fn(),
  deriveAgentPublicKeyMock: vi.fn(),
  getSolanaConnectionMock: vi.fn(),
  deserializeInstructionMock: vi.fn(),
  getAddressLookupTableAccountsMock: vi.fn(),
  deriveNearAgentAccountMock: vi.fn(),
  ensureNearAccountFundedMock: vi.fn(),
}));

vi.mock("../../../utils/http", () => ({
  fetchWithRetry: mocks.fetchWithRetryMock,
}));

vi.mock("../../../state/status", () => ({
  setStatus: mocks.setStatusMock,
}));

vi.mock("../../../utils/solana", () => ({
  deriveAgentPublicKey: mocks.deriveAgentPublicKeyMock,
  getSolanaConnection: mocks.getSolanaConnectionMock,
  deserializeInstruction: mocks.deserializeInstructionMock,
  getAddressLookupTableAccounts: mocks.getAddressLookupTableAccountsMock,
}));

vi.mock("../../../utils/near", () => ({
  deriveNearAgentAccount: mocks.deriveNearAgentAccountMock,
  ensureNearAccountFunded: mocks.ensureNearAccountFundedMock,
}));

function mockContext() {
  return {
    json(payload: unknown, status = 200) {
      return new Response(JSON.stringify(payload), { status });
    },
  } as any;
}

describe("sell quote handlers", () => {
  beforeEach(() => {
    mocks.fetchWithRetryMock.mockReset();
    mocks.setStatusMock.mockReset();
    mocks.deriveAgentPublicKeyMock.mockReset();
    mocks.getSolanaConnectionMock.mockReset();
    mocks.deserializeInstructionMock.mockReset();
    mocks.getAddressLookupTableAccountsMock.mockReset();
    mocks.deriveNearAgentAccountMock.mockReset();
    mocks.ensureNearAccountFundedMock.mockReset();

    mocks.deriveAgentPublicKeyMock.mockResolvedValue(
      new PublicKey("8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u"),
    );
    mocks.getSolanaConnectionMock.mockReturnValue({
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "11111111111111111111111111111111",
      }),
    });
    mocks.getAddressLookupTableAccountsMock.mockResolvedValue([]);
    mocks.deserializeInstructionMock.mockReturnValue(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey("11111111111111111111111111111111"),
        data: Buffer.alloc(0),
      }),
    );
    mocks.fetchWithRetryMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            outAmount: "123",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            swapInstruction: {
              programId: "11111111111111111111111111111111",
              accounts: [],
              data: "",
            },
            addressLookupTableAddresses: [],
          }),
          { status: 200 },
        ),
      );

    mocks.deriveNearAgentAccountMock.mockResolvedValue({
      accountId: "agent.test.near",
    });
  });

  it("does not persist state for Solana sell quote when dry is true", async () => {
    const res = await handleSellQuote(
      mockContext(),
      {
        originAsset: "1cs_v1:sol:spl:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263:6",
        amount: "1000",
      } as any,
      true,
      "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
      "near",
      "alice.near",
      "nep141:wrap.near",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.confirmRequired).toBe(false);
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
  });

  it("persists state for Solana sell quote when dry is false", async () => {
    const res = await handleSellQuote(
      mockContext(),
      {
        originAsset: "1cs_v1:sol:spl:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263:6",
        amount: "1000",
      } as any,
      false,
      "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
      "near",
      "alice.near",
      "nep141:wrap.near",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.confirmRequired).toBe(true);
    expect(mocks.setStatusMock).toHaveBeenCalledTimes(1);
  });

  it("does not fund or persist state for NEAR sell quote when dry is true", async () => {
    const res = await handleNearSellQuote(
      mockContext(),
      {
        originAsset: "nep141:wrap.near",
        amount: "1000",
      } as any,
      true,
      "alice.testnet",
      "solana",
      "5tFfXhz6Z6Ed7QfA9hUJW6QcgQn3Ejj6inUeJ8V4aH7T",
      "1cs_v1:sol:native",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.confirmRequired).toBe(false);
    expect(mocks.ensureNearAccountFundedMock).not.toHaveBeenCalled();
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
  });

  it("funds and persists state for NEAR sell quote when dry is false", async () => {
    const res = await handleNearSellQuote(
      mockContext(),
      {
        originAsset: "nep141:wrap.near",
        amount: "1000",
      } as any,
      false,
      "alice.testnet",
      "solana",
      "5tFfXhz6Z6Ed7QfA9hUJW6QcgQn3Ejj6inUeJ8V4aH7T",
      "1cs_v1:sol:native",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.confirmRequired).toBe(true);
    expect(mocks.ensureNearAccountFundedMock).toHaveBeenCalledTimes(1);
    expect(mocks.setStatusMock).toHaveBeenCalledTimes(1);
  });
});
