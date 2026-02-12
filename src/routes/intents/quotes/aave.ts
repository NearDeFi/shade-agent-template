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

const log = createLogger("intents/quotes/aave");

export async function handleAaveDepositQuote(ctx: QuoteContext) {
  const { c, payload, defuseQuoteFields, isDryRun, sourceChain, userDestination, metadata } = ctx;
  const evmChain = detectEvmChainFromAsset(payload.destinationAsset);
  if (!evmChain || !["ethereum", "base", "arbitrum"].includes(evmChain)) {
    throw new AppError(
      "invalid_request",
      "Aave V3 deposit requires destination on ethereum, base, or arbitrum",
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

  log.info("Aave deposit: requesting bridge quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    evmChain,
    amount: payload.amount,
    dry: isDryRun,
    agentRecipient: agentEvmAddress,
  });

  const { intentsQuote, baseQuote, amountOut } = await fetchAndExtractQuote(
    bridgeQuoteRequest,
    "Aave deposit",
  );

  const quoteId = generateQuoteId(baseQuote, "shade-aave-deposit");

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
        metadata: { ...metadata, action: "aave-deposit" },
      })
    : undefined;

  await tryAutoEnqueue({
    isDryRun,
    depositAddress: baseQuote.depositAddress,
    sourceChain,
    userDestination,
    intent: enqueueIntent,
    flowCatalog,
    logLabel: "Aave deposit",
  });

  return c.json(buildQuoteResponse(intentsQuote, payload, isDryRun, baseQuote, quoteId, amountOut, {
    evmChain,
    protocol: "aave-v3",
  }));
}

export async function handleAaveWithdrawQuote(
  ctx: QuoteContext,
  aaveWithdraw: { underlyingAsset: string; bridgeBack?: { destinationChain: string; destinationAddress: string; destinationAsset: string; slippageTolerance?: number } },
) {
  const { c, payload, isDryRun } = ctx;
  const quoteId = `shade-aave-withdraw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return c.json({
    timestamp: new Date().toISOString(),
    signature: "",
    quoteRequest: { ...payload, dry: isDryRun },
    quote: {
      quoteId,
      amountOut: payload.amount,
      minAmountOut: payload.amount,
      underlyingAsset: aaveWithdraw.underlyingAsset,
      protocol: "aave-v3",
      message: "Submit withdraw intent via POST /api/intents with userSignature",
    },
  });
}
