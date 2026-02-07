import type { Context } from "hono";
import { IntentChain } from "../../../queue/types";
import { flowCatalog } from "../../../queue/flowCatalog";
import { deriveAgentPublicKey } from "../../../utils/solana";
import type { QuoteRequestBody, IntentsQuoteResponse } from "../types";
import {
  buildAutoEnqueueIntent,
  fetchDefuseQuote,
  extractQuoteAmount,
  generateQuoteId,
  tryAutoEnqueue,
  buildQuoteResponse,
} from "../helpers";
import { createLogger } from "../../../utils/logger";
import { getIntentsApiBase } from "../../../infra/intentsApi";
import { AppError } from "../../../errors/appError";

const log = createLogger("intents/quotes/kamino");

export async function handleKaminoDepositQuote(
  c: Context,
  payload: QuoteRequestBody,
  defuseQuoteFields: Record<string, unknown>,
  isDryRun: boolean,
  kaminoDeposit: { marketAddress: string; mintAddress: string },
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  let agentSolanaAddress: string | undefined;
  if (userDestination) {
    const agentPubkey = await deriveAgentPublicKey(undefined, userDestination);
    agentSolanaAddress = agentPubkey.toBase58();
  }

  const directQuoteRequest = {
    ...defuseQuoteFields,
    dry: isDryRun,
    ...(agentSolanaAddress && {
      recipient: agentSolanaAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  log.info("Kamino deposit: requesting direct quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    amount: payload.amount,
    slippageTolerance: payload.slippageTolerance,
    dry: isDryRun,
    intentsQuoteUrl: getIntentsApiBase(),
    agentRecipient: agentSolanaAddress,
    kaminoMarket: kaminoDeposit.marketAddress,
    kaminoMint: kaminoDeposit.mintAddress,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = await fetchDefuseQuote(directQuoteRequest);
  } catch (err) {
    log.error("Kamino deposit: intents quote failed", { err: String(err) });
    throw new AppError("upstream_error", (err as Error).message, { cause: err });
  }

  const baseQuote = intentsQuote.quote || {};
  const amountResult = extractQuoteAmount(baseQuote);
  if ("error" in amountResult) {
    throw new AppError("upstream_error", amountResult.error);
  }
  const amountOut = amountResult.amount;

  const quoteId = generateQuoteId(baseQuote, "shade-kamino");

  const enqueueIntent = !isDryRun
    ? buildAutoEnqueueIntent({
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: "solana",
        intermediateAmount: amountOut,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination: agentSolanaAddress,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: {
          ...metadata,
          action: "kamino-deposit",
          marketAddress: kaminoDeposit.marketAddress,
          mintAddress: kaminoDeposit.mintAddress,
          targetDefuseAssetId: payload.destinationAsset,
          useIntents: true,
        },
      })
    : undefined;

  await tryAutoEnqueue({
    isDryRun,
    depositAddress: baseQuote.depositAddress,
    sourceChain,
    userDestination,
    intent: enqueueIntent,
    flowCatalog,
    logLabel: "Kamino deposit",
  });

  return c.json(buildQuoteResponse(intentsQuote, payload, isDryRun, baseQuote, quoteId, amountOut));
}
