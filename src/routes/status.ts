import { Hono } from "hono";
import { getStatus, listStatuses } from "../state/status";
import { createLogger } from "../utils/logger";
import { handleRouteError } from "./errorHandling";

const log = createLogger("status");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

app.get("/", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "", 10) || 50, 500);
  const intents = await listStatuses(limit);
  return c.json({ intents });
});

app.get("/:intentId", async (c) => {
  const intentId = c.req.param("intentId");
  const status = await getStatus(intentId);
  if (!status) {
    return c.json({ intentId, status: "unknown" }, 404);
  }
  return c.json({ intentId, ...status });
});

export default app;
