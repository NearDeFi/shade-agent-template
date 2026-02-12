import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import statusApp from "./status";

const { getStatusMock, listStatusesMock } = vi.hoisted(() => ({
  getStatusMock: vi.fn(),
  listStatusesMock: vi.fn(),
}));

vi.mock("../state/status", () => ({
  getStatus: getStatusMock,
  listStatuses: listStatusesMock,
}));

const app = new Hono().route("/api/status", statusApp);

describe("status route", () => {
  it("returns known status", async () => {
    getStatusMock.mockResolvedValue({ state: "succeeded", txId: "tx123" });

    const res = await app.request("/api/status/intent-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intentId).toBe("intent-1");
    expect(body.state).toBe("succeeded");
    expect(body.txId).toBe("tx123");
  });

  it("returns 404 for unknown intent", async () => {
    getStatusMock.mockResolvedValue(null);

    const res = await app.request("/api/status/missing");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("unknown");
  });

  describe("GET / (listStatuses)", () => {
    it("returns intents with default limit", async () => {
      listStatusesMock.mockResolvedValue([
        { intentId: "a", state: "succeeded" },
        { intentId: "b", state: "processing" },
      ]);

      const res = await app.request("/api/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intents).toHaveLength(2);
      expect(listStatusesMock).toHaveBeenCalledWith(50);
    });

    it("accepts custom limit parameter", async () => {
      listStatusesMock.mockResolvedValue([]);

      const res = await app.request("/api/status?limit=10");
      expect(res.status).toBe(200);
      expect(listStatusesMock).toHaveBeenCalledWith(10);
    });

    it("caps limit at 500", async () => {
      listStatusesMock.mockResolvedValue([]);

      const res = await app.request("/api/status?limit=9999");
      expect(res.status).toBe(200);
      expect(listStatusesMock).toHaveBeenCalledWith(500);
    });

    it("returns empty array when no intents", async () => {
      listStatusesMock.mockResolvedValue([]);

      const res = await app.request("/api/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intents).toEqual([]);
    });
  });
});
