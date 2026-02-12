import { Hono } from "hono";
import {
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  SolanaAdapter,
} from "../utils/solana";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";

const log = createLogger("solAccount");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

app.get("/", async (c) => {
  try {
    const path = c.req.query("path") || SOLANA_DEFAULT_PATH;
    const agentAddress = await deriveAgentPublicKey(path);
    const { balance, decimals } = await SolanaAdapter.getBalance(agentAddress);
    const balanceLamports = balance.toString();
    const balanceSol = Number(balance) / 10 ** decimals;

    return c.json({
      address: agentAddress,
      path,
      balanceLamports,
      balanceSol,
    });
  } catch (error) {
    throw new AppError("operation_failed", (error as Error).message, {
      cause: error,
    });
  }
});

export default app;
