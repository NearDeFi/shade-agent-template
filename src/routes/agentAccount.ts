import { Hono } from "hono";
import { agentAccountId, agent } from "@neardefi/shade-agent-js";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";

const log = createLogger("agentAccount");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

app.get("/", async (c) => {
  // Get the agents account Id
  const accountId = await agentAccountId();

  // Get the balance of the agent account
  const balance = await agent("getBalance");

  if (!accountId?.accountId || balance?.balance === undefined) {
    throw new AppError("internal_error", "Failed to get agent account");
  }

  return c.json({
    accountId: accountId.accountId,
    balance: balance.balance,
  });
});

export default app;
