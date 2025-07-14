import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import dotenv from "dotenv";

// Load environment variables from .env file (only needed for local development)
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: ".env.development.local" });
}

// Import routes
import ethAccount from "./routes/ethAccount";
import agentAccount from "./routes/agentAccount";
import transaction from "./routes/transaction";

const app = new Hono();

// Configure CORS to restrict access to the server
app.use(cors());

// Health check
app.get("/", (c) => c.json({ message: "App is running" }));

// Routes
app.route("/api/eth-account", ethAccount);
app.route("/api/agent-account", agentAccount);
app.route("/api/transaction", transaction);

// Start the server
const port = Number(process.env.PORT || "3000");

console.log(`App is running on port ${port}`);

serve({ fetch: app.fetch, port });
