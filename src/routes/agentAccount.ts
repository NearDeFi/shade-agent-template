import { Hono } from "hono";
import { getAgentAccount, getBalance } from "@neardefi/shade-agent-js";

const app = new Hono();

app.get("/", async (c) => {
  try {
    const accountId = await getAgentAccount();
    const balance = await getBalance(accountId.workerAccountId);
    return c.json({
      accountId: accountId.workerAccountId,
      balance: balance.available,
    });
  } catch (error) {
    console.log("Error getting worker account:", error);
    return c.json({ error: "Failed to get worker account " + error }, 500);
  }
});

export default app;
