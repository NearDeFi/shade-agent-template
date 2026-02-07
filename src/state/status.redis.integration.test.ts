import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { IntentState } from "./status";

const runRedisIntegration = process.env.RUN_REDIS_INTEGRATION === "1";
const describeRedis = runRedisIntegration ? describe : describe.skip;

const ALL_STATES: IntentState[] = [
  "pending",
  "processing",
  "awaiting_deposit",
  "awaiting_intents",
  "awaiting_user_tx",
  "succeeded",
  "failed",
];

describeRedis("status redis integration concurrency", () => {
  let redis: Redis;
  let setStatus: typeof import("./status").setStatus;
  let getStatus: typeof import("./status").getStatus;
  let transitionStatus: typeof import("./status").transitionStatus;
  let getIntentsByState: typeof import("./status").getIntentsByState;
  const createdIntentIds = new Set<string>();

  beforeAll(async () => {
    ({ setStatus, getStatus, transitionStatus, getIntentsByState } = await import("./status"));
    redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    await redis.ping();
  });

  afterEach(async () => {
    if (createdIntentIds.size === 0) {
      return;
    }

    const ids = [...createdIntentIds];
    const statusKeys = ids.map((id) => `intent:status:${id}`);
    await redis.del(...statusKeys);
    for (const state of ALL_STATES) {
      if (ids.length > 0) {
        await redis.srem(`intent:status:state:${state}`, ...ids);
      }
    }
    createdIntentIds.clear();
  });

  afterAll(async () => {
    await redis.quit();
  });

  function createIntentId(label: string): string {
    const id = `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    createdIntentIds.add(id);
    return id;
  }

  it("keeps exactly one state-index membership under concurrent setStatus writes", async () => {
    const intentId = createIntentId("set-status-race");

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        setStatus(intentId, {
          state: ALL_STATES[index % ALL_STATES.length],
          detail: `writer-${index}`,
        }),
      ),
    );

    const finalStatus = await getStatus(intentId);
    expect(finalStatus).not.toBeNull();

    const memberships = await Promise.all(
      ALL_STATES.map((state) =>
        redis.sismember(`intent:status:state:${state}`, intentId),
      ),
    );
    const memberStates = memberships
      .map((value, idx) => (value === 1 ? ALL_STATES[idx] : null))
      .filter((state): state is IntentState => state !== null);

    expect(memberStates).toHaveLength(1);
    expect(memberStates[0]).toBe(finalStatus!.state);

    const indexed = await getIntentsByState(finalStatus!.state);
    const matched = indexed.filter((entry) => entry.intentId === intentId);
    expect(matched).toHaveLength(1);
  });

  it("allows only one successful transition winner under concurrent claims", async () => {
    const intentId = createIntentId("transition-race");
    await setStatus(intentId, {
      state: "awaiting_user_tx",
      detail: "ready",
      intentData: {
        intentId,
        sourceChain: "solana",
        sourceAsset: "So11111111111111111111111111111111111111112",
        sourceAmount: "1000",
        destinationChain: "near",
        finalAsset: "nep141:wrap.near",
        userDestination: "4cJgUe8TKEkJtqWSXoe4fAhN74LW2TbK4DGVkfdxUJZk",
        agentDestination: "8CKsW6cVfaQnBxpqtKfxDxZ8sM3E7DbpDZEPXx1cBa9u",
        slippageBps: 300,
      },
    });

    const contenders = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        transitionStatus(intentId, "awaiting_user_tx", {
          state: "processing",
          detail: `worker-${index}`,
        }),
      ),
    );

    const winners = contenders.filter((result) => result.updated);
    expect(winners).toHaveLength(1);

    const finalStatus = await getStatus(intentId);
    expect(finalStatus?.state).toBe("processing");

    const awaitingMember = await redis.sismember(
      "intent:status:state:awaiting_user_tx",
      intentId,
    );
    const processingMember = await redis.sismember(
      "intent:status:state:processing",
      intentId,
    );
    expect(awaitingMember).toBe(0);
    expect(processingMember).toBe(1);
  });
});
