import { Hono } from "hono";
import { getTransferSolInstruction } from "@solana-program/system";
import { requestSignature } from "@neardefi/shade-agent-js";
import {
  deriveAgentPublicKey,
  getSolanaRpc,
  buildAndCompileTransaction,
  SOLANA_DEFAULT_PATH,
} from "../utils/solana";
import { createDummySigner } from "../utils/chainSignature";
import { parseSignature } from "../utils/signature";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";

const log = createLogger("chainsigTest");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

app.get("/", async (c) => {
  const agentAddress = await deriveAgentPublicKey();

  // Build a trivial self-transfer to exercise signing; we do not broadcast.
  const rpc = getSolanaRpc();
  const compiledTx = await buildAndCompileTransaction({
    instructions: [
      getTransferSolInstruction({
        source: createDummySigner(agentAddress),
        destination: agentAddress,
        amount: 1n,
      }),
    ],
    feePayer: agentAddress,
    rpc,
  });

  const payloadHex = Buffer.from(compiledTx.messageBytes).toString("hex");

  const signRes = await requestSignature({
    path: SOLANA_DEFAULT_PATH,
    payload: payloadHex,
    keyType: "Eddsa",
  });

  if (!signRes.signature) {
    throw new AppError("operation_failed", "No signature returned");
  }

  const parsed = parseSignature(signRes.signature);
  if (!parsed) {
    throw new AppError("operation_failed", "Unsupported signature encoding");
  }

  return c.json({
    agentPublicKey: agentAddress,
    payloadHexLength: payloadHex.length,
    signatureHex: Buffer.from(parsed).toString("hex"),
    status: "signed",
  });
});

export default app;
