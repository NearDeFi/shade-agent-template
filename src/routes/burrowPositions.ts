import { Hono } from "hono";
import {
  listBurrowMarkets,
  getUserPositions,
} from "../utils/burrow";
import {
  deriveNearImplicitAccount,
  NEAR_DEFAULT_PATH,
} from "../utils/chainSignature";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";

const log = createLogger("burrowPositions");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

// GET /api/burrow-positions/markets
// Returns all available Burrow markets with their current rates and liquidity
app.get("/markets", async (c) => {
  try {
    const markets = await listBurrowMarkets();

    return c.json({
      markets,
      count: markets.length,
    });
  } catch (err) {
    throw new AppError("operation_failed", (err as Error).message, { cause: err });
  }
});

// GET /api/burrow-positions/derive?userDestination=...
// Derives the NEAR implicit account for a given user destination (NEAR account ID)
app.get("/derive", async (c) => {
  const userDestination = c.req.query("userDestination");

  if (!userDestination) {
    throw new AppError("invalid_request", "userDestination query parameter is required");
  }

  try {
    log.info(`Deriving NEAR account for userDestination: ${userDestination}`);

    const { accountId, publicKey } = await deriveNearImplicitAccount(
      NEAR_DEFAULT_PATH,
      undefined, // no nearPublicKey
      userDestination,
    );

    log.info(`Derived NEAR account: ${accountId}`);

    return c.json({
      userDestination,
      derivedAccountId: accountId,
      derivedPublicKey: publicKey,
    });
  } catch (err) {
    throw new AppError("operation_failed", (err as Error).message, { cause: err });
  }
});

// GET /api/burrow-positions/user?userDestination=...
// Gets positions for the derived account from a user destination (NEAR account ID)
app.get("/user", async (c) => {
  const userDestination = c.req.query("userDestination");

  if (!userDestination) {
    throw new AppError("invalid_request", "userDestination query parameter is required");
  }

  try {
    // Derive the NEAR implicit account using userDestination for custody isolation
    // This matches the derivation used in burrowDeposit/burrowWithdraw flows
    const { accountId, publicKey } = await deriveNearImplicitAccount(
      NEAR_DEFAULT_PATH,
      undefined, // no nearPublicKey
      userDestination,
    );

    // Get positions for the derived account
    const positions = await getUserPositions(accountId);

    return c.json({
      userDestination,
      derivedAccountId: accountId,
      derivedPublicKey: publicKey,
      ...positions,
    });
  } catch (err) {
    throw new AppError("operation_failed", (err as Error).message, { cause: err });
  }
});

// GET /api/burrow-positions
// Returns instructions for using the API
app.get("/", async (c) => {
  return c.json({
    message: "Burrow Finance Positions API",
    endpoints: {
      markets: "GET /api/burrow-positions/markets - List all available markets",
      derive: "GET /api/burrow-positions/derive?userDestination=... - Derive NEAR implicit account",
      user: "GET /api/burrow-positions/user?userDestination=... - Get positions for derived account",
      positions: "GET /api/burrow-positions/:accountId - Get positions by account ID directly",
    },
    examples: {
      markets: "/api/burrow-positions/markets",
      derive: "/api/burrow-positions/derive?userDestination=user.near",
      user: "/api/burrow-positions/user?userDestination=user.near",
      positions: "/api/burrow-positions/abc123def456...  (64-char implicit account)",
    },
  });
});

// GET /api/burrow-positions/:accountId
// Returns user's positions in Burrow (supplied, collateral, borrowed)
// NOTE: This route must be last to avoid matching /markets, /derive, /user
app.get("/:accountId", async (c) => {
  const accountId = c.req.param("accountId");

  if (!accountId) {
    throw new AppError("invalid_request", "accountId is required");
  }

  try {
    const positions = await getUserPositions(accountId);
    return c.json(positions);
  } catch (err) {
    throw new AppError("operation_failed", (err as Error).message, { cause: err });
  }
});

export default app;
