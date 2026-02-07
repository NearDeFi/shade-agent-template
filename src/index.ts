import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
import { openApiSpec } from "./openapi";
import { createLogger } from "./utils/logger";
import { handleRouteError } from "./routes/errorHandling";

const log = createLogger("server");

import { startQueueConsumer } from "./queue/consumer";
import { startIntentsPoller } from "./queue/intentsPoller";
import { startOrderPoller } from "./queue/orderPoller";
import type { BackgroundTaskHandle } from "./queue/runtime";
import { config } from "./config";
import {
  flowCatalog,
  intentValidator,
} from "./queue/flowCatalog";

// dotenv is loaded by config.ts at import time; no need to call it again here

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

app.onError((err, c) => handleRouteError(c, err, log));

// Configure CORS - wildcard by default, optional allow-list via CORS_ALLOWED_ORIGINS.
app.use(
  cors({
    origin: config.corsAllowedOrigins.length > 0 ? config.corsAllowedOrigins : "*",
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
const registeredFlows = flowCatalog.getAll();
log.info(`Registered ${registeredFlows.length} flows: ${registeredFlows.map((f) => f.action).join(", ")}`);

log.info(`App is running on port ${port}`);

const server = serve({ fetch: app.fetch, port });
const backgroundTasks: BackgroundTaskHandle[] = [];

async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down`);

  const stoppedTasks = await Promise.allSettled(
    backgroundTasks.map((task) => task.stop()),
  );
  for (const [idx, result] of stoppedTasks.entries()) {
    if (result.status === "rejected") {
      log.error(`Background task ${idx} failed to stop`, {
        err: String(result.reason),
      });
    }
  }

  await new Promise<void>((resolve) => {
    const closable = server as unknown as {
      close?: (cb?: (err?: Error) => void) => void;
    };
    if (typeof closable.close !== "function") {
      resolve();
      return;
    }
    closable.close(() => resolve());
  });

  process.exit(0);
}

let isShuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    shutdown(signal).catch((err) => {
      log.error("Shutdown failed", { err: String(err) });
      process.exit(1);
    });
  });
}

if (config.enableQueue) {
  try {
    backgroundTasks.push(
      startQueueConsumer({
        flowCatalog,
        validateIntent: intentValidator,
      }),
    );
  } catch (err) {
    log.error("Failed to start queue consumer", { err: String(err) });
  }

  // Start the intents poller to monitor cross-chain swaps
  try {
    backgroundTasks.push(startIntentsPoller());
  } catch (err) {
    log.error("Failed to start intents poller", { err: String(err) });
  }

  // Start the order poller to monitor prices for conditional orders
  try {
    backgroundTasks.push(startOrderPoller());
  } catch (err) {
    log.error("Failed to start order poller", { err: String(err) });
  }
} else {
  log.info("Queue consumer disabled (enable via ENABLE_QUEUE=true)");
}
