import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import dotenv from "dotenv";
import { ShadeClient } from "@neardefi/shade-agent-js";
import agentInfo from "./routes/agentInfo";
import ethInfo from "./routes/ethAccountInfo";
import transaction from "./routes/transaction";

// Load environment variables from .env file (only needed for local development)
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}
const agentContractId = process.env.AGENT_CONTRACT_ID;
const sponsorAccountId = process.env.SPONSOR_ACCOUNT_ID;
const sponsorPrivateKey = process.env.SPONSOR_PRIVATE_KEY;
if (!agentContractId || !sponsorAccountId || !sponsorPrivateKey) {
  throw new Error(
    "Missing required environment variables AGENT_CONTRACT_ID, SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY",
  );
}

// Initialize Shade Agent client
export const agent = await ShadeClient.create({
  networkId: "testnet",
  agentContractId: agentContractId, // Agent contract the agent will interact with
  sponsor: {
    // Sponsor account details that will fund the agent
    accountId: sponsorAccountId,
    privateKey: sponsorPrivateKey,
  },
  // Derivation path for fixed agent account ID for local
  derivationPath: sponsorPrivateKey, // Random string kept secret (private key does a good job)
});

// Initialize app
const app = new Hono();

// Middleware
app.use(cors());

// Routes
app.get("/", (c) => c.json({ message: "App is running" }));
app.route("/api/agent-info", agentInfo);
app.route("/api/eth-info", ethInfo);
app.route("/api/transaction", transaction);

console.log("Agent account ID:", agent.accountId());

// If the agent has low balance, fund it
const balance = await agent.balance();
if (balance < 0.2) {
  await agent.fund(0.3);
}

while (true) {
  try {
    // Register the agent if whitelisted or if the agent contract requires TEE
    const isWhitelisted = await agent.isWhitelisted();
    if (isWhitelisted === null || isWhitelisted) {
      const registered = await agent.register();
      if (registered) {
        console.log("Agent registered");
        break;
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
  console.log("Whitelist the agent account ID");
  await new Promise((resolve) => setTimeout(resolve, 10000));
}

// Re-register every 6 days
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const registered = await agent.register();
    if (registered) {
      console.log("Agent re-registered");
    }
  } catch (error) {
    console.error("Error re-registering agent:", error);
  }
}, SIX_DAYS_MS);

// Start server after registration is complete
const port = Number(process.env.PORT || "3000");
console.log(`Server starting on port ${port}...`);
serve({ fetch: app.fetch, port });
