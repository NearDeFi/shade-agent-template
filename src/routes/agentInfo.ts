import { Hono } from "hono";
import { agent } from "../index";

const app = new Hono();

app.get("/", async (c) => {
  try {
    // Get the agent's account ID
    const accountId = agent.accountId();

    // Get the balance of the agent in NEAR
    const balance = await agent.balance();

    return c.json({
      accountId,
      balance,
      agentContractId: process.env.AGENT_CONTRACT_ID,
    });
  } catch (error) {
    console.log("Failed to get agent info:", error);
    return c.json({ error: "Failed to get agent info: " + error }, 500);
  }
});

export default app;
