import { Hono } from "hono";
import type { QuoteRequestBody } from "./types";
import { getIntentsApiBase } from "../../infra/intentsApi";
import { AppError } from "../../errors/appError";
import { createLogger } from "../../utils/logger";
import { handleRouteError, parseJsonBody } from "../errorHandling";
import { dispatchIntentQuote } from "./dispatch";

const log = createLogger("intents/quote");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

app.post("/quote", async (c) => {
  if (!getIntentsApiBase()) {
    throw new AppError("internal_error", "INTENTS_QUOTE_URL is not configured");
  }

  const payload = await parseJsonBody<QuoteRequestBody>(c);

  if (!payload.originAsset || !payload.destinationAsset || !payload.amount) {
    throw new AppError(
      "invalid_request",
      "originAsset, destinationAsset, and amount are required",
    );
  }

  return dispatchIntentQuote(c, payload);
});

export default app;
