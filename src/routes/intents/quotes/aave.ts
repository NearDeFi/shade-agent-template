import type { Context } from "hono";
import { IntentChain } from "../../../queue/types";
import { detectEvmChainFromAsset, deriveEvmAgentAddress } from "../../../utils/evmChains";
import { OpenAPI } from "@defuse-protocol/one-click-sdk-typescript";
import { flowCatalog } from "../../../queue/flowCatalog";
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
import { AppError } from "../../../errors/appError";

const log = createLogger("intents/quotes/aave");

export async function handleAaveDepositQuote(
  c: Context,
  payload: QuoteRequestBody,
  defuseQuoteFields: Record<string, unknown>,
  isDryRun: boolean,
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
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

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = await fetchDefuseQuote(bridgeQuoteRequest);
  } catch (err) {
    log.error("Aave deposit: bridge quote failed", { err: String(err) });
    throw new AppError("upstream_error", (err as Error).message, { cause: err });
  }

  const baseQuote = intentsQuote.quote || {};
  const amountResult = extractQuoteAmount(baseQuote);
  if ("error" in amountResult) {
    throw new AppError("upstream_error", amountResult.error);
  }
  const amountOut = amountResult.amount;

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
  c: Context,
  payload: QuoteRequestBody,
  isDryRun: boolean,
  aaveWithdraw: { underlyingAsset: string; bridgeBack?: { destinationChain: string; destinationAddress: string; destinationAsset: string; slippageTolerance?: number } },
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
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
