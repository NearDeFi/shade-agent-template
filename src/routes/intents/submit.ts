import { Hono } from "hono";
import { config } from "../../config";
import { createLogger } from "../../utils/logger";
import { AppError } from "../../errors/appError";
import { handleRouteError, parseJsonBody } from "../errorHandling";
import { submitIntentForProcessing } from "../../services/intentsSubmitService";
import type { IntentMessage } from "../../queue/types";
import { intentValidator } from "../../queue/flowCatalog";

const log = createLogger("intents/submit");

const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

/**
 * POST /api/intents - Enqueue an intent for processing
 *
 * SECURITY: This endpoint requires valid verification proof:
 * 1. Deposit-verified intents: Must have originTxHash + intentsDepositAddress
 *    (Used for Kamino deposits where the deposit tx is the authorization)
 * 2. Signature-verified intents: Must have valid userSignature (NEP-413)
 *    (Used for Kamino withdrawals where there's no deposit)
 *
 * Regular swaps should NOT use this endpoint - they are auto-enqueued
 * when requesting a quote with dry: false via POST /api/intents/quote
 */
app.post("/", async (c) => {
  if (!config.enableQueue) {
    throw new AppError("service_unavailable", "Queue consumer is disabled");
  }

  const payload = await parseJsonBody<IntentMessage>(c);
  const result = await submitIntentForProcessing(payload, intentValidator);
  return c.json(result, 202);
});

export default app;
