import type { Context } from "hono";
import {
  IntentMessage,
  IntentChain,
  type IntentMetadata,
} from "../../queue/types";
import { validateIntent } from "../../queue/validation";
import { enqueueIntentWithStatus } from "../../state/status";
import { config } from "../../config";
import {
  OneClickService,
} from "@defuse-protocol/one-click-sdk-typescript";
import { createLogger } from "../../utils/logger";
import type { QuoteRequestBody, IntentsQuoteResponse } from "./types";
import { ensureIntentsApiBase } from "../../infra/intentsApi";
import { AppError } from "../../errors/appError";
import type { FlowCatalog } from "../../flows/catalog";

const log = createLogger("intents/helpers");

// ─── QuoteContext ────────────────────────────────────────────────────────────

/**
 * Shared context passed to all quote handlers, eliminating loose parameter passing.
 */
export interface QuoteContext {
  c: Context;
  payload: QuoteRequestBody;
  defuseQuoteFields: Record<string, unknown>;
  isDryRun: boolean;
  sourceChain?: IntentChain;
  userDestination?: string;
  metadata?: Record<string, unknown>;
}

// ─── Quote Helpers ────────────────────────────────────────────────────────────

/**
 * Fetch a Defuse/Intents quote and extract the output amount in one call.
 * Wraps the common fetch → extract → validate pattern used by all quote handlers.
 */
export async function fetchAndExtractQuote(
  quoteRequest: Record<string, unknown>,
  logLabel: string,
): Promise<{ intentsQuote: IntentsQuoteResponse; baseQuote: Record<string, any>; amountOut: string }> {
  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = await fetchDefuseQuote(quoteRequest);
  } catch (err) {
    log.error(`${logLabel}: intents quote failed`, { err: String(err) });
    throw new AppError("upstream_error", (err as Error).message, { cause: err });
  }

  const baseQuote = intentsQuote.quote || {};
  const amountResult = extractQuoteAmount(baseQuote);
  if ("error" in amountResult) {
    throw new AppError("upstream_error", amountResult.error);
  }

  return { intentsQuote, baseQuote, amountOut: amountResult.amount };
}

/**
 * Fetch a quote from the Defuse/Intents 1-Click API.
 */
export async function fetchDefuseQuote(
  quoteRequest: Record<string, unknown>,
): Promise<IntentsQuoteResponse> {
  ensureIntentsApiBase();
  // `as any` justified: SDK types don't expose the full request shape
  return (await OneClickService.getQuote(
    quoteRequest as any,
  )) as IntentsQuoteResponse;
}

/**
 * Extract and validate the output amount from a Defuse quote response.
 * Returns the amount as a clean integer string, or null with an error message.
 */
export function extractQuoteAmount(
  baseQuote: Record<string, any>,
): { amount: string } | { error: string } {
  const rawAmountOut =
    baseQuote.amountOut ||
    baseQuote.minAmountOut ||
    baseQuote.amountIn ||
    baseQuote.amount;

  if (!rawAmountOut) {
    return { error: "Intents quote missing amountOut" };
  }

  try {
    return { amount: BigInt(rawAmountOut).toString() };
  } catch {
    return { error: `Invalid amount format from intents: ${rawAmountOut}` };
  }
}

/**
 * Generate a quote ID for tracking.
 * Uses the 1-Click quoteId if available, otherwise generates a prefixed one.
 */
export function generateQuoteId(
  baseQuote: Record<string, any>,
  prefix = "shade",
): string {
  return baseQuote.quoteId || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Auto-enqueue an intent for processing.
 * Validates and enqueues the intent, sets status to pending.
 */
export async function autoEnqueueIntent(
  intentMessage: IntentMessage,
  flowCatalog: FlowCatalog,
): Promise<void> {
  const validatedIntent = validateIntent(intentMessage, flowCatalog);
  await enqueueIntentWithStatus(validatedIntent, { state: "pending" });
}

export interface BuildAutoEnqueueIntentParams {
  intentId: string;
  sourceChain?: IntentChain;
  sourceAsset: string;
  sourceAmount: string;
  destinationChain: IntentChain;
  intermediateAmount?: string;
  finalAsset: string;
  slippageBps?: number;
  userDestination?: string;
  agentDestination?: string;
  intentsDepositAddress?: string;
  depositMemo?: string;
  metadata?: IntentMetadata;
}

export function buildAutoEnqueueIntent(
  params: BuildAutoEnqueueIntentParams,
): IntentMessage {
  if (!params.sourceChain) {
    throw new AppError("invalid_request", "sourceChain is required when dry: false");
  }
  if (!params.userDestination) {
    throw new AppError("invalid_request", "userDestination is required when dry: false");
  }
  if (!params.agentDestination) {
    throw new AppError("invalid_request", "agentDestination is required when dry: false");
  }

  return {
    intentId: params.intentId,
    sourceChain: params.sourceChain,
    sourceAsset: params.sourceAsset,
    sourceAmount: params.sourceAmount,
    destinationChain: params.destinationChain,
    intermediateAmount: params.intermediateAmount,
    finalAsset: params.finalAsset,
    slippageBps: params.slippageBps,
    userDestination: params.userDestination,
    agentDestination: params.agentDestination,
    intentsDepositAddress: params.intentsDepositAddress,
    depositMemo: params.depositMemo,
    metadata: params.metadata,
  };
}

/**
 * Build a standard quote JSON response.
 */
export function buildQuoteResponse(
  intentsQuote: IntentsQuoteResponse,
  payload: Record<string, unknown>,
  isDryRun: boolean,
  baseQuote: Record<string, any>,
  quoteId: string,
  amountOut: string,
  extra: Record<string, unknown> = {},
) {
  return {
    timestamp: intentsQuote.timestamp || new Date().toISOString(),
    signature: intentsQuote.signature || "",
    quoteRequest: {
      ...payload,
      dry: isDryRun,
    },
    quote: {
      ...baseQuote,
      quoteId,
      amountOut,
      minAmountOut: amountOut,
      destinationAsset: payload.destinationAsset,
      depositAddress: baseQuote.depositAddress,
      depositMemo: baseQuote.depositMemo,
      ...extra,
    },
  };
}

/**
 * Try to auto-enqueue an intent when conditions are met (not dry run, queue enabled, deposit address present).
 * Throws AppError on validation/enqueue failures.
 */
export async function tryAutoEnqueue(
  opts: {
    isDryRun: boolean;
    depositAddress?: string;
    sourceChain?: IntentChain;
    userDestination?: string;
    intent?: IntentMessage;
    flowCatalog: FlowCatalog;
    logLabel: string;
  },
): Promise<void> {
  if (opts.isDryRun || !config.enableQueue || !opts.depositAddress) {
    return;
  }

  if (!opts.sourceChain) {
    throw new AppError("invalid_request", "sourceChain is required when dry: false");
  }
  if (!opts.userDestination) {
    throw new AppError("invalid_request", "userDestination is required when dry: false");
  }
  if (!opts.intent) {
    throw new AppError("internal_error", "Missing intent payload for auto-enqueue");
  }

  try {
    await autoEnqueueIntent(opts.intent, opts.flowCatalog);
    log.info(`${opts.logLabel} intent auto-enqueued`, {
      intentId: opts.intent.intentId,
      sourceChain: opts.sourceChain,
      depositAddress: opts.depositAddress,
    });
  } catch (err) {
    log.error(`Failed to auto-enqueue ${opts.logLabel} intent`, { err: String(err) });
    throw new AppError("internal_error", "Failed to enqueue intent for processing", { cause: err });
  }
}
