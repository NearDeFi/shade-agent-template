import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
import dotenv from "dotenv";
import { openApiSpec } from "./openapi";

// Import flows first to trigger self-registration before consumer starts
import "./flows";

import { startQueueConsumer } from "./queue/consumer";
import { startIntentsPoller } from "./queue/intentsPoller";
import { startOrderPoller } from "./queue/orderPoller";
import { config } from "./config";
import { flowRegistry } from "./flows";

// Load environment variables from .env file (only needed for local development)
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: ".env.development.local" });
}

// Import routes
import ethAccount from "./routes/ethAccount";
import agentAccount from "./routes/agentAccount";
import transaction from "./routes/transaction";
import status from "./routes/status";
import chainsigTest from "./routes/chainsigTest";
import intents from "./routes/intents";
import solAccount from "./routes/solAccount";
import kaminoPositions from "./routes/kaminoPositions";
import burrowPositions from "./routes/burrowPositions";
import aavePositions from "./routes/aavePositions";
import morphoPositions from "./routes/morphoPositions";
import orders from "./routes/orders";
// import permission from "./routes/permission";

const app = new Hono();

// Configure CORS - allow all origins for API access
app.use(
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Health check
app.get("/", (c) => c.json({ message: "App is running" }));

// OpenAPI spec endpoint
app.get("/api/openapi.json", (c) => c.json(openApiSpec));

// Swagger UI - interactive API documentation
app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));

// Routes
app.route("/api/eth-account", ethAccount);
app.route("/api/agent-account", agentAccount);
app.route("/api/transaction", transaction);
app.route("/api/status", status);
app.route("/api/chainsig-test", chainsigTest);
app.route("/api/intents", intents);
app.route("/api/sol-account", solAccount);
app.route("/api/kamino-positions", kaminoPositions);
app.route("/api/burrow-positions", burrowPositions);
app.route("/api/aave-positions", aavePositions);
app.route("/api/morpho-positions", morphoPositions);
app.route("/api/orders", orders);
// app.route("/api/permission", permission);

// Start the server
const port = Number(process.env.PORT || "3000");

// Log registered flows
const registeredFlows = flowRegistry.getAll();
console.log(`Registered ${registeredFlows.length} flows: ${registeredFlows.map((f) => f.action).join(", ")}`);

console.log(`App is running on port ${port}`);

serve({ fetch: app.fetch, port });

if (config.enableQueue) {
  startQueueConsumer().catch((err) => {
    console.error("Failed to start queue consumer", err);
  });

  // Start the intents poller to monitor cross-chain swaps
  startIntentsPoller().catch((err) => {
    console.error("Failed to start intents poller", err);
  });

  // Start the order poller to monitor prices for conditional orders
  startOrderPoller().catch((err) => {
    console.error("Failed to start order poller", err);
  });
} else {
  console.log("Queue consumer disabled (enable via ENABLE_QUEUE=true)");
}
