import { IntentChain } from "../../../queue/types";
import { detectEvmChainFromAsset, deriveEvmAgentAddress } from "../../../utils/evmChains";
import { flowCatalog } from "../../../queue/flowCatalog";
import {
  buildAutoEnqueueIntent,
  fetchAndExtractQuote,
  generateQuoteId,
  tryAutoEnqueue,
  buildQuoteResponse,
  type QuoteContext,
} from "../helpers";
import { createLogger } from "../../../utils/logger";
import { AppError } from "../../../errors/appError";

const log = createLogger("intents/quotes/morpho");

export async function handleMorphoDepositQuote(
  ctx: QuoteContext,
  morphoDeposit: { marketId: string; loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string },
) {
  const { c, payload, defuseQuoteFields, isDryRun, sourceChain, userDestination, metadata } = ctx;
  const evmChain = detectEvmChainFromAsset(payload.destinationAsset);
  if (!evmChain || !["ethereum", "base"].includes(evmChain)) {
    throw new AppError(
      "invalid_request",
      "Morpho Blue deposit requires destination on ethereum or base",
    );
  }

  let agentEvmAddress: string | undefined;
  if (userDestination) {
    agentEvmAddress = await deriveEvmAgentAddress(userDestination);
  }

  const bridgeQuoteRequest = {
    ...defuseQuoteFields,
    dry: isDryRun,
    ...(agentEvmAddress && {
      recipient: agentEvmAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  log.info("Morpho deposit: requesting bridge quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    evmChain,
    amount: payload.amount,
    dry: isDryRun,
    agentRecipient: agentEvmAddress,
    morphoMarketId: morphoDeposit.marketId,
  });

  const { intentsQuote, baseQuote, amountOut } = await fetchAndExtractQuote(
    bridgeQuoteRequest,
    "Morpho deposit",
  );

  const quoteId = generateQuoteId(baseQuote, "shade-morpho-deposit");

  const enqueueIntent = !isDryRun
    ? buildAutoEnqueueIntent({
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: evmChain as IntentChain,
        intermediateAmount: amountOut,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination: agentEvmAddress,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: {
          ...metadata,
          action: "morpho-deposit",
          marketId: morphoDeposit.marketId,
          loanToken: morphoDeposit.loanToken,
          collateralToken: morphoDeposit.collateralToken,
          oracle: morphoDeposit.oracle,
          irm: morphoDeposit.irm,
          lltv: morphoDeposit.lltv,
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
    logLabel: "Morpho deposit",
  });

  return c.json(buildQuoteResponse(intentsQuote, payload, isDryRun, baseQuote, quoteId, amountOut, {
    evmChain,
    protocol: "morpho-blue",
    morphoMarketId: morphoDeposit.marketId,
  }));
}

export async function handleMorphoWithdrawQuote(
  ctx: QuoteContext,
  morphoWithdraw: { marketId: string; loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string; bridgeBack?: { destinationChain: string; destinationAddress: string; destinationAsset: string; slippageTolerance?: number } },
) {
  const { c, payload, isDryRun } = ctx;
  const quoteId = `shade-morpho-withdraw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return c.json({
    timestamp: new Date().toISOString(),
    signature: "",
    quoteRequest: { ...payload, dry: isDryRun },
    quote: {
      quoteId,
      amountOut: payload.amount,
      minAmountOut: payload.amount,
      morphoMarketId: morphoWithdraw.marketId,
      protocol: "morpho-blue",
      message: "Submit withdraw intent via POST /api/intents with userSignature",
    },
  });
}
