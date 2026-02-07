import { Hono } from "hono";
import { Evm } from "../utils/ethereum";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";

const log = createLogger("ethAccount");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

app.get("/", async (c) => {
  const contractId = process.env.NEXT_PUBLIC_contractId;
  if (!contractId) {
    throw new AppError("operation_failed", "Contract ID not configured");
  }

  // Derive the price pusher Ethereum address
  const { address: senderAddress } = await Evm.deriveAddressAndPublicKey(
    contractId,
    "ethereum-1",
  );

  // Get the balance of the address
  const balance = await Evm.getBalance(senderAddress);

  return c.json({ senderAddress, balance: String(balance.balance) });
});

export default app;
