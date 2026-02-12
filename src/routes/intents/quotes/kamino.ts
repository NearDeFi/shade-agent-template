import { flowCatalog } from "../../../queue/flowCatalog";
import { deriveAgentPublicKey } from "../../../utils/solana";
import {
  buildAutoEnqueueIntent,
  fetchAndExtractQuote,
  generateQuoteId,
  tryAutoEnqueue,
  buildQuoteResponse,
  type QuoteContext,
} from "../helpers";
import { createLogger } from "../../../utils/logger";
import { getIntentsApiBase } from "../../../infra/intentsApi";

const log = createLogger("intents/quotes/kamino");

export async function handleKaminoDepositQuote(
  ctx: QuoteContext,
  kaminoDeposit: { marketAddress: string; mintAddress: string },
) {
  const { c, payload, defuseQuoteFields, isDryRun, sourceChain, userDestination, metadata } = ctx;
  let agentSolanaAddress: string | undefined;
  if (userDestination) {
    const agentPubkey = await deriveAgentPublicKey(undefined, userDestination);
    agentSolanaAddress = agentPubkey;
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

  const { intentsQuote, baseQuote, amountOut } = await fetchAndExtractQuote(
    directQuoteRequest,
    "Kamino deposit",
  );

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
