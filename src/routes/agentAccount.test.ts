import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import agentAccountApp from "./agentAccount";

const { agentAccountIdMock, agentMock } = vi.hoisted(() => ({
  agentAccountIdMock: vi.fn(),
  agentMock: vi.fn(),
}));

vi.mock("@neardefi/shade-agent-js", () => ({
  agentAccountId: agentAccountIdMock,
  agent: agentMock,
}));

const app = new Hono().route("/api/agent-account", agentAccountApp);

describe("agentAccount route", () => {
  beforeEach(() => {
    agentAccountIdMock.mockReset();
    agentMock.mockReset();
    agentAccountIdMock.mockResolvedValue({ accountId: "agent.test" });
    agentMock.mockResolvedValue({ balance: "42" });
  });

  it("returns account id and balance", async () => {
    const res = await app.request("/api/agent-account");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBe("agent.test");
    expect(body.balance).toBe("42");
  });

  it("returns 500 when agentAccountId fails", async () => {
    agentAccountIdMock.mockResolvedValue(null);
    const res = await app.request("/api/agent-account");
    expect(res.status).toBe(500);
  });

  it("returns 500 when balance is undefined", async () => {
    agentMock.mockResolvedValue({});
    const res = await app.request("/api/agent-account");
    expect(res.status).toBe(500);
  });
});
