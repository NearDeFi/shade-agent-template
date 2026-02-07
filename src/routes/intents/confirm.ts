import { Hono } from "hono";
import { config } from "../../config";
import { AppError } from "../../errors/appError";
import { confirmIntentUserTransaction } from "../../services/intentsConfirmService";
import { intentValidator } from "../../queue/flowCatalog";
import { createLogger } from "../../utils/logger";
import { handleRouteError, parseJsonBody } from "../errorHandling";

const log = createLogger("intents/confirm");
const app = new Hono();

app.onError((err, c) => handleRouteError(c, err, log));

/**
 * POST /api/intents/:intentId/confirm
 *
 * Confirm a user-signed sell transaction.
 * After the user signs and broadcasts the sell TX (Jupiter for Solana, ft_transfer for NEAR),
 * this endpoint verifies it on-chain and enqueues the bridge-out intent.
 */
app.post("/:intentId/confirm", async (c) => {
  if (!config.enableQueue) {
    throw new AppError("service_unavailable", "Queue consumer is disabled");
  }

  const intentId = c.req.param("intentId");
  const body = await parseJsonBody<{ txHash: string }>(c);

  if (!body.txHash) {
    throw new AppError("invalid_request", "txHash is required");
  }

  const result = await confirmIntentUserTransaction(intentId, body.txHash, intentValidator);
  return c.json(result);
});

export default app;
