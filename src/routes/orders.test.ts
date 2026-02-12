import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import ordersApp, { createOrderCancelSigningMessage } from "./orders";
import { config } from "../config";

const mocks = vi.hoisted(() => ({
  enqueueIntentMock: vi.fn(),
  validateIntentMock: vi.fn(),
  setStatusMock: vi.fn(),
  enqueueIntentWithStatusMock: vi.fn(),
  getOrderMock: vi.fn(),
  listUserOrdersMock: vi.fn(),
  markOrderFundedMock: vi.fn(),
  getOrderDescriptionMock: vi.fn(),
  getPollerStatusMock: vi.fn(),
  checkOrdersMock: vi.fn(),
  deriveOrderAgentAddressMock: vi.fn(),
  isNearSignatureMock: vi.fn(),
  verifyNearSignatureMock: vi.fn(),
  verifySolanaSignatureMock: vi.fn(),
}));

// Prevent @ref-finance/ref-sdk from requiring 'react' at import time
vi.mock("@ref-finance/ref-sdk", () => ({
  init_env: vi.fn(),
  ftGetTokenMetadata: vi.fn(),
  fetchAllPools: vi.fn(),
  estimateSwap: vi.fn(),
  instantSwap: vi.fn(),
}));

vi.mock("../queue/redis", () => ({
  RedisQueueClient: vi.fn().mockImplementation(() => ({
    enqueueIntent: mocks.enqueueIntentMock,
  })),
}));

vi.mock("../queue/validation", () => ({
  validateIntent: mocks.validateIntentMock,
}));

vi.mock("../state/status", () => ({
  setStatus: mocks.setStatusMock,
  enqueueIntentWithStatus: mocks.enqueueIntentWithStatusMock,
}));

vi.mock("../state/orders", () => ({
  getOrder: mocks.getOrderMock,
  listUserOrders: mocks.listUserOrdersMock,
  markOrderFunded: mocks.markOrderFundedMock,
  getOrderDescription: mocks.getOrderDescriptionMock,
}));

vi.mock("../queue/orderPoller", () => ({
  getPollerStatus: mocks.getPollerStatusMock,
  checkOrders: mocks.checkOrdersMock,
}));

vi.mock("../flows/orderCreate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/orderCreate")>();
  return {
    ...actual,
    deriveOrderAgentAddress: mocks.deriveOrderAgentAddressMock,
  };
});

vi.mock("../utils/nearSignature", () => ({
  verifyNearSignature: mocks.verifyNearSignatureMock,
  isNearSignature: mocks.isNearSignatureMock,
}));

vi.mock("../utils/solanaSignature", () => ({
  verifySolanaSignature: mocks.verifySolanaSignatureMock,
}));

const app = new Hono().route("/api/orders", ordersApp);

const createPayload = {
  orderId: "order-12345",
  orderType: "limit",
  side: "sell",
  priceAsset: "SOL",
  quoteAsset: "USDC",
  triggerPrice: "150",
  priceCondition: "above",
  sourceChain: "solana",
  sourceAsset: "So11111111111111111111111111111111111111112",
  amount: "1000000",
  destinationChain: "solana",
  targetAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
};

describe("orders route signature binding", () => {
  beforeEach(() => {
    config.enableQueue = true;
    config.orderFundingApiKey = "";
    mocks.enqueueIntentMock.mockReset();
    mocks.validateIntentMock.mockReset();
    mocks.setStatusMock.mockReset();
    mocks.enqueueIntentWithStatusMock.mockReset();
    mocks.getOrderMock.mockReset();
    mocks.listUserOrdersMock.mockReset();
    mocks.markOrderFundedMock.mockReset();
    mocks.getOrderDescriptionMock.mockReset();
    mocks.getPollerStatusMock.mockReset();
    mocks.checkOrdersMock.mockReset();
    mocks.deriveOrderAgentAddressMock.mockReset();
    mocks.isNearSignatureMock.mockReset();
    mocks.verifyNearSignatureMock.mockReset();
    mocks.verifySolanaSignatureMock.mockReset();

    mocks.enqueueIntentWithStatusMock.mockImplementation(async (intent: { intentId: string }, status: unknown) => {
      await mocks.enqueueIntentMock(intent);
      await mocks.setStatusMock(intent.intentId, status);
    });

    mocks.validateIntentMock.mockImplementation((intent) => intent);
    mocks.deriveOrderAgentAddressMock.mockResolvedValue(
      "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
    );
    mocks.getOrderDescriptionMock.mockReturnValue("order");
    mocks.getPollerStatusMock.mockResolvedValue({ activePairs: 0, activeOrders: 0, pairs: [] });
    mocks.checkOrdersMock.mockResolvedValue({ checked: 0, triggered: 0 });
  });

  it("rejects create when signed message does not match payload", async () => {
    mocks.isNearSignatureMock.mockReturnValue(true);
    mocks.verifyNearSignatureMock.mockReturnValue(true);

    const res = await app.request("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...createPayload,
        userSignature: {
          type: "near",
          message: "wrong-message",
          signature: "sig",
          publicKey: "ed25519:abc",
          nonce: Buffer.alloc(32).toString("base64"),
          recipient: "receiver",
        },
      }),
    });

    expect(res.status).toBe(403);
    expect(mocks.enqueueIntentMock).not.toHaveBeenCalled();
  });

  it("rejects cancel when Solana signer does not match userDestination", async () => {
    const orderId = "order-12345";
    const owner = "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk";
    const wrongSigner = "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u";
    const expectedMessage = createOrderCancelSigningMessage(orderId, owner, true);

    mocks.getOrderMock.mockResolvedValue({
      orderId,
      state: "active",
      userAddress: owner,
      sourceChain: "solana",
      sourceAsset: "So11111111111111111111111111111111111111112",
      amount: "1000000",
      agentChain: "solana",
      agentAddress: "agent",
    });
    mocks.isNearSignatureMock.mockReturnValue(false);
    mocks.verifySolanaSignatureMock.mockReturnValue(true);

    const res = await app.request(`/api/orders/${orderId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        userDestination: owner,
        refundFunds: true,
        userSignature: {
          type: "solana",
          message: expectedMessage,
          signature: "sig",
          publicKey: wrongSigner,
        },
      }),
    });

    expect(res.status).toBe(403);
    expect(mocks.enqueueIntentMock).not.toHaveBeenCalled();
  });

  it("accepts cancel when message and Solana signer both match", async () => {
    const orderId = "order-12345";
    const owner = "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk";
    const expectedMessage = createOrderCancelSigningMessage(orderId, owner, true);

    mocks.getOrderMock.mockResolvedValue({
      orderId,
      state: "active",
      userAddress: owner,
      sourceChain: "solana",
      sourceAsset: "So11111111111111111111111111111111111111112",
      amount: "1000000",
      agentChain: "solana",
      agentAddress: "agent",
    });
    mocks.isNearSignatureMock.mockReturnValue(false);
    mocks.verifySolanaSignatureMock.mockReturnValue(true);

    const res = await app.request(`/api/orders/${orderId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        userDestination: owner,
        refundFunds: true,
        userSignature: {
          type: "solana",
          message: expectedMessage,
          signature: "sig",
          publicKey: owner,
        },
      }),
    });

    expect(res.status).toBe(202);
    expect(mocks.enqueueIntentMock).toHaveBeenCalledTimes(1);
  });

  it("rejects /fund when funding key is not configured", async () => {
    const orderId = "order-12345";
    const owner = "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk";

    mocks.getOrderMock.mockResolvedValue({
      orderId,
      state: "pending",
      userAddress: owner,
      sourceChain: "solana",
      sourceAsset: "So11111111111111111111111111111111111111112",
      amount: "1000000",
      agentChain: "solana",
      agentAddress: "agent",
    });

    const res = await app.request(`/api/orders/${orderId}/fund`, {
      method: "POST",
    });

    expect(res.status).toBe(503);
    expect(mocks.getOrderMock).not.toHaveBeenCalled();
    expect(mocks.markOrderFundedMock).not.toHaveBeenCalled();
  });

  it("rejects /fund with invalid funding key", async () => {
    config.orderFundingApiKey = "secret-key";
    const orderId = "order-12345";

    const res = await app.request(`/api/orders/${orderId}/fund`, {
      method: "POST",
      headers: { "x-order-funding-key": "wrong-key" },
    });

    expect(res.status).toBe(401);
    expect(mocks.getOrderMock).not.toHaveBeenCalled();
    expect(mocks.markOrderFundedMock).not.toHaveBeenCalled();
  });

  it("allows /fund with valid funding key", async () => {
    config.orderFundingApiKey = "secret-key";
    const orderId = "order-12345";
    const owner = "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk";

    mocks.getOrderMock.mockResolvedValue({
      orderId,
      state: "pending",
      userAddress: owner,
      sourceChain: "solana",
      sourceAsset: "So11111111111111111111111111111111111111112",
      amount: "1000000",
      agentChain: "solana",
      agentAddress: "agent",
    });
    mocks.markOrderFundedMock.mockResolvedValue({
      orderId,
      state: "active",
      userAddress: owner,
      sourceChain: "solana",
      sourceAsset: "So11111111111111111111111111111111111111112",
      amount: "1000000",
      agentChain: "solana",
      agentAddress: "agent",
    });

    const res = await app.request(`/api/orders/${orderId}/fund`, {
      method: "POST",
      headers: { "x-order-funding-key": "secret-key" },
    });

    expect(res.status).toBe(200);
    expect(mocks.markOrderFundedMock).toHaveBeenCalledWith(orderId);
  });
});
