import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleNearSellQuote, handleSellQuote } from "./sell";

const mocks = vi.hoisted(() => ({
  fetchWithRetryMock: vi.fn(),
  setStatusMock: vi.fn(),
  deriveAgentPublicKeyMock: vi.fn(),
  getSolanaRpcMock: vi.fn(),
  deserializeInstructionMock: vi.fn(),
  getAddressLookupTableAccountsMock: vi.fn(),
  buildAndCompileTransactionMock: vi.fn(),
  deriveNearAgentAccountMock: vi.fn(),
  ensureNearAccountFundedMock: vi.fn(),
  findAssociatedTokenPdaMock: vi.fn(),
}));

vi.mock("../../../utils/http", () => ({
  fetchWithRetry: mocks.fetchWithRetryMock,
}));

vi.mock("../../../state/status", () => ({
  setStatus: mocks.setStatusMock,
}));

vi.mock("../../../utils/solana", () => ({
  deriveAgentPublicKey: mocks.deriveAgentPublicKeyMock,
  getSolanaRpc: mocks.getSolanaRpcMock,
  deserializeInstruction: mocks.deserializeInstructionMock,
  getAddressLookupTableAccounts: mocks.getAddressLookupTableAccountsMock,
  buildAndCompileTransaction: mocks.buildAndCompileTransactionMock,
}));

vi.mock("@solana-program/token", () => ({
  findAssociatedTokenPda: mocks.findAssociatedTokenPdaMock,
  TOKEN_PROGRAM_ADDRESS: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
}));

vi.mock("../../../utils/near", () => ({
  deriveNearAgentAccount: mocks.deriveNearAgentAccountMock,
  ensureNearAccountFunded: mocks.ensureNearAccountFundedMock,
}));

function mockQuoteContext(payload: Record<string, unknown>, isDryRun: boolean) {
  return {
    c: {
      json(data: unknown, status = 200) {
        return new Response(JSON.stringify(data), { status });
      },
    } as any,
    payload: payload as any,
    defuseQuoteFields: {},
    isDryRun,
  };
}

describe("sell quote handlers", () => {
  beforeEach(() => {
    mocks.fetchWithRetryMock.mockReset();
    mocks.setStatusMock.mockReset();
    mocks.deriveAgentPublicKeyMock.mockReset();
    mocks.getSolanaRpcMock.mockReset();
    mocks.deserializeInstructionMock.mockReset();
    mocks.getAddressLookupTableAccountsMock.mockReset();
    mocks.buildAndCompileTransactionMock.mockReset();
    mocks.deriveNearAgentAccountMock.mockReset();
    mocks.ensureNearAccountFundedMock.mockReset();
    mocks.findAssociatedTokenPdaMock.mockReset();

    // deriveAgentPublicKey now returns Address (plain string)
    mocks.deriveAgentPublicKeyMock.mockResolvedValue(
      "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
    );
    // findAssociatedTokenPda returns [ata, bump]
    mocks.findAssociatedTokenPdaMock.mockResolvedValue([
      "AgentWsolAta111111111111111111111111111111111",
      255,
    ]);
    mocks.getSolanaRpcMock.mockReturnValue({});
    mocks.getAddressLookupTableAccountsMock.mockResolvedValue({});
    // deserializeInstruction returns Kit IInstruction
    mocks.deserializeInstructionMock.mockReturnValue({
      programAddress: "11111111111111111111111111111111",
      accounts: [],
      data: new Uint8Array(0),
    });
    // buildAndCompileTransaction returns a CompiledTransaction
    mocks.buildAndCompileTransactionMock.mockResolvedValue({
      messageBytes: new Uint8Array([1, 2, 3]),
      signatures: { "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk": new Uint8Array(64) },
    });
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
      mockQuoteContext(
        {
          originAsset: "1cs_v1:sol:spl:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263:6",
          amount: "1000",
        },
        true,
      ),
      {
        userSourceAddress: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
        sellDestinationChain: "near",
        sellDestinationAddress: "alice.near",
        sellDestinationAsset: "nep141:wrap.near",
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.confirmRequired).toBe(false);
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
  });

  it("persists state for Solana sell quote when dry is false", async () => {
    const res = await handleSellQuote(
      mockQuoteContext(
        {
          originAsset: "1cs_v1:sol:spl:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263:6",
          amount: "1000",
        },
        false,
      ),
      {
        userSourceAddress: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
        sellDestinationChain: "near",
        sellDestinationAddress: "alice.near",
        sellDestinationAsset: "nep141:wrap.near",
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.confirmRequired).toBe(true);
    expect(mocks.setStatusMock).toHaveBeenCalledTimes(1);
  });

  it("does not fund or persist state for NEAR sell quote when dry is true", async () => {
    const res = await handleNearSellQuote(
      mockQuoteContext(
        {
          originAsset: "nep141:wrap.near",
          amount: "1000",
        },
        true,
      ),
      {
        userNearAddress: "alice.testnet",
        sellDestinationChain: "solana",
        sellDestinationAddress: "5tFfXhz6Z6Ed7QfA9hUJW6QcgQn3Ejj6inUeJ8V4aH7T",
        sellDestinationAsset: "1cs_v1:sol:native",
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.confirmRequired).toBe(false);
    expect(mocks.ensureNearAccountFundedMock).not.toHaveBeenCalled();
    expect(mocks.setStatusMock).not.toHaveBeenCalled();
  });

  it("funds and persists state for NEAR sell quote when dry is false", async () => {
    const res = await handleNearSellQuote(
      mockQuoteContext(
        {
          originAsset: "nep141:wrap.near",
          amount: "1000",
        },
        false,
      ),
      {
        userNearAddress: "alice.testnet",
        sellDestinationChain: "solana",
        sellDestinationAddress: "5tFfXhz6Z6Ed7QfA9hUJW6QcgQn3Ejj6inUeJ8V4aH7T",
        sellDestinationAsset: "1cs_v1:sol:native",
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.confirmRequired).toBe(true);
    expect(mocks.ensureNearAccountFundedMock).toHaveBeenCalledTimes(1);
    expect(mocks.setStatusMock).toHaveBeenCalledTimes(1);
  });
});
