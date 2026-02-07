import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntentStatus } from "./status";

const mocks = vi.hoisted(() => ({
  smembersMock: vi.fn(),
  mgetMock: vi.fn(),
  sremMock: vi.fn(),
  setMock: vi.fn(),
  getMock: vi.fn(),
  scanMock: vi.fn(),
  watchMock: vi.fn(),
  unwatchMock: vi.fn(),
  pipelineExecMock: vi.fn(),
  multiExecMock: vi.fn(),
}));

vi.mock("../infra/redis", () => ({
  redis: {
    smembers: mocks.smembersMock,
    mget: mocks.mgetMock,
    srem: mocks.sremMock,
    set: mocks.setMock,
    get: mocks.getMock,
    scan: mocks.scanMock,
    watch: mocks.watchMock,
    unwatch: mocks.unwatchMock,
    pipeline: () => ({
      set: () => undefined,
      srem: () => undefined,
      sadd: () => undefined,
      exec: mocks.pipelineExecMock,
    }),
    multi: () => ({
      set: () => undefined,
      srem: () => undefined,
      sadd: () => undefined,
      exec: mocks.multiExecMock,
    }),
  },
}));

import { getIntentsByState } from "./status";

describe("status state index", () => {
  beforeEach(() => {
    mocks.smembersMock.mockReset();
    mocks.mgetMock.mockReset();
    mocks.sremMock.mockReset();
    mocks.setMock.mockReset();
    mocks.getMock.mockReset();
    mocks.scanMock.mockReset();
    mocks.watchMock.mockReset();
    mocks.unwatchMock.mockReset();
    mocks.pipelineExecMock.mockReset();
    mocks.multiExecMock.mockReset();
  });

  it("returns indexed statuses for the requested state", async () => {
    const status: IntentStatus = { state: "awaiting_intents", detail: "waiting" };
    mocks.smembersMock.mockResolvedValue(["intent-1"]);
    mocks.mgetMock.mockResolvedValue([JSON.stringify(status)]);

    const result = await getIntentsByState("awaiting_intents");

    expect(result).toEqual([{ intentId: "intent-1", state: "awaiting_intents", detail: "waiting" }]);
    expect(mocks.sremMock).not.toHaveBeenCalled();
  });

  it("removes stale index entries when keys are missing or state drifted", async () => {
    mocks.smembersMock.mockResolvedValue(["intent-missing", "intent-drifted", "intent-ok"]);
    mocks.mgetMock.mockResolvedValue([
      null,
      JSON.stringify({ state: "processing" }),
      JSON.stringify({ state: "awaiting_intents", txId: "tx-1" }),
    ]);

    const result = await getIntentsByState("awaiting_intents");

    expect(result).toEqual([
      { intentId: "intent-ok", state: "awaiting_intents", txId: "tx-1" },
    ]);
    expect(mocks.sremMock).toHaveBeenCalledWith(
      "intent:status:state:awaiting_intents",
      "intent-missing",
      "intent-drifted",
    );
  });
});
