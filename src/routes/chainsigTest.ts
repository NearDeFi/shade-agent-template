import { Hono } from "hono";
import { SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { requestSignature } from "@neardefi/shade-agent-js";
import { deriveAgentPublicKey, getSolanaConnection, SOLANA_DEFAULT_PATH } from "../utils/solana";
import { parseSignature } from "../utils/signature";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";

const log = createLogger("chainsigTest");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

app.get("/", async (c) => {
  const connection = getSolanaConnection();
  const agentPubkey = await deriveAgentPublicKey();
  const { blockhash } = await connection.getLatestBlockhash("finalized");

  // Build a trivial self-transfer to exercise signing; we do not broadcast.
  const messageV0 = new TransactionMessage({
    payerKey: agentPubkey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: agentPubkey,
        toPubkey: agentPubkey,
        lamports: 1n,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  const payloadHex = Buffer.from(tx.message.serialize()).toString("hex");

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

  tx.signatures[0] = parsed;

  return c.json({
    agentPublicKey: agentPubkey.toBase58(),
    payloadHexLength: payloadHex.length,
    signatureHex: Buffer.from(parsed).toString("hex"),
    status: "signed",
  });
});

export default app;
