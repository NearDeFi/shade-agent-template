import { Hono } from "hono";
import submit from "./submit";
import quote from "./quote";
import confirm from "./confirm";

const app = new Hono();

// POST /api/intents - Submit an intent for processing
app.route("/", submit);

// POST /api/intents/quote - Get a quote (and optionally auto-enqueue)
app.route("/", quote);

// POST /api/intents/:intentId/confirm - Confirm a user-signed sell TX
app.route("/", confirm);

export default app;
