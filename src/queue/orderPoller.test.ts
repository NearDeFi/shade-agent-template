import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "../state/orders";

const mocks = vi.hoisted(() => ({
  getActiveOrdersByPricePairMock: vi.fn(),
  getExpiredOrdersMock: vi.fn(),
  getTriggeredOrdersMock: vi.fn(),
  shouldTriggerMock: vi.fn(),
  setOrderStateMock: vi.fn(),
  transitionOrderStateMock: vi.fn(),
  getOrderDescriptionMock: vi.fn(),
  getPriceMock: vi.fn(),
  formatPriceMock: vi.fn(),
  enqueueIntentMock: vi.fn(),
}));

vi.mock("../state/orders", () => ({
  getActiveOrdersByPricePair: mocks.getActiveOrdersByPricePairMock,
  getExpiredOrders: mocks.getExpiredOrdersMock,
  getTriggeredOrders: mocks.getTriggeredOrdersMock,
  shouldTrigger: mocks.shouldTriggerMock,
  setOrderState: mocks.setOrderStateMock,
  transitionOrderState: mocks.transitionOrderStateMock,
  getOrderDescription: mocks.getOrderDescriptionMock,
}));

vi.mock("../utils/priceFeed", () => ({
  getPrice: mocks.getPriceMock,
  formatPrice: mocks.formatPriceMock,
}));

vi.mock("./redis", () => ({
  RedisQueueClient: vi.fn().mockImplementation(() => ({
    enqueueIntent: mocks.enqueueIntentMock,
  })),
}));

import { checkOrders } from "./orderPoller";

const sampleOrder: Order = {
  orderId: "order-1",
  state: "active",
  orderType: "limit",
  side: "sell",
  priceAsset: "SOL",
  quoteAsset: "USDC",
  triggerPrice: "100",
  priceCondition: "above",
  sourceChain: "solana",
  sourceAsset: "So11111111111111111111111111111111111111112",
  amount: "1000000",
  destinationChain: "solana",
  targetAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  userAddress: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
  userChain: "solana",
  agentAddress: "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
  agentChain: "solana",
  slippageTolerance: 300,
  createdAt: Date.now(),
};

describe("orderPoller race handling", () => {
  beforeEach(() => {
    mocks.getActiveOrdersByPricePairMock.mockReset();
    mocks.getExpiredOrdersMock.mockReset();
    mocks.getTriggeredOrdersMock.mockReset();
    mocks.shouldTriggerMock.mockReset();
    mocks.setOrderStateMock.mockReset();
    mocks.transitionOrderStateMock.mockReset();
    mocks.getOrderDescriptionMock.mockReset();
    mocks.getPriceMock.mockReset();
    mocks.formatPriceMock.mockReset();
    mocks.enqueueIntentMock.mockReset();

    mocks.getActiveOrdersByPricePairMock.mockResolvedValue(
      new Map([["SOL:USDC", [sampleOrder]]]),
    );
    mocks.getTriggeredOrdersMock.mockResolvedValue([]);
    mocks.getPriceMock.mockResolvedValue({
      price: 101,
      timestamp: Date.now(),
      source: "test",
    });
    mocks.shouldTriggerMock.mockReturnValue(true);
    mocks.formatPriceMock.mockReturnValue("101.000000");
    mocks.getOrderDescriptionMock.mockReturnValue("order");
  });

  it("does not enqueue when atomic trigger claim fails", async () => {
    mocks.transitionOrderStateMock.mockResolvedValue({
      updated: false,
      order: { ...sampleOrder, state: "triggered" },
      currentState: "triggered",
    });

    const result = await checkOrders();

    expect(result.checked).toBe(1);
    expect(result.triggered).toBe(0);
    expect(mocks.enqueueIntentMock).not.toHaveBeenCalled();
    expect(mocks.transitionOrderStateMock).toHaveBeenCalledWith(
      "order-1",
      "active",
      "triggered",
      { triggeredPrice: "101.000000" },
    );
  });

  it("enqueues once when atomic trigger claim succeeds", async () => {
    mocks.transitionOrderStateMock.mockResolvedValue({
      updated: true,
      order: { ...sampleOrder, state: "triggered" },
      currentState: "triggered",
    });
    mocks.enqueueIntentMock.mockResolvedValue(undefined);

    const result = await checkOrders();

    expect(result.checked).toBe(1);
    expect(result.triggered).toBe(1);
    expect(mocks.enqueueIntentMock).toHaveBeenCalledTimes(1);
    expect(mocks.transitionOrderStateMock).toHaveBeenCalledTimes(1);
  });

  it("rolls order back to active when enqueue fails after claim", async () => {
    mocks.transitionOrderStateMock
      .mockResolvedValueOnce({
        updated: true,
        order: { ...sampleOrder, state: "triggered" },
        currentState: "triggered",
      })
      .mockResolvedValueOnce({
        updated: true,
        order: { ...sampleOrder, state: "active" },
        currentState: "active",
      });
    mocks.enqueueIntentMock.mockRejectedValue(new Error("queue unavailable"));

    const result = await checkOrders();

    expect(result.checked).toBe(1);
    expect(result.triggered).toBe(0);
    expect(mocks.transitionOrderStateMock).toHaveBeenNthCalledWith(
      2,
      "order-1",
      "triggered",
      "active",
      {
        triggeredPrice: undefined,
        triggeredAt: undefined,
      },
    );
  });
});
