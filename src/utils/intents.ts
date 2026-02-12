/**
 * Shared utilities for Defuse Intents cross-chain operations
 */

import {
  OneClickService,
} from "@defuse-protocol/one-click-sdk-typescript";
import type { AppConfig } from "../flows/types";
import { createLogger } from "./logger";
import { ensureIntentsApiBase } from "../infra/intentsApi";

const log = createLogger("intents");

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface BridgeBackConfig {
  destinationChain: string;
  destinationAddress: string;
  destinationAsset: string;
  slippageTolerance?: number;
}

export interface IntentsQuoteRequest {
  /** The origin asset in Defuse format (e.g., "nep141:wrap.near" or "solana:native") */
  originAsset: string;
  /** The destination asset in Defuse format */
  destinationAsset: string;
  /** Amount to bridge in base units */
  amount: string;
  /** Recipient address on destination chain */
  recipient: string;
  /** Refund address if the swap fails */
  refundAddress: string;
  /** Slippage tolerance in basis points (default: 300 = 3%) */
  slippageTolerance?: number;
  /** Deadline for the quote (default: 30 minutes from now) */
  deadline?: string;
}

export interface IntentsQuoteResult {
  /** The deposit address to send tokens to */
  depositAddress: string;
  /** The full quote response from the API */
  quoteResponse: unknown;
}

// ─── Functions ──────────────────────────────────────────────────────────────────

/**
 * Get an intents quote and deposit address for a cross-chain swap.
 * This is the common logic shared by all bridgeBack implementations.
 *
 * @param request - The quote request parameters
 * @param config - App configuration (for intentsQuoteUrl)
 * @returns The deposit address and full quote response
 */
export async function getIntentsQuote(
  request: IntentsQuoteRequest,
  _config: AppConfig,
): Promise<IntentsQuoteResult> {
  ensureIntentsApiBase();

  const deadline = request.deadline ?? new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const quoteRequest = {
    originAsset: request.originAsset,
    destinationAsset: request.destinationAsset,
    amount: request.amount,
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: request.slippageTolerance ?? 300,
    dry: false,
    recipient: request.recipient,
    recipientType: "DESTINATION_CHAIN" as const,
    refundTo: request.refundAddress,
    refundType: "ORIGIN_CHAIN" as const,
    depositType: "ORIGIN_CHAIN" as const,
    deadline,
  };

  log.info("Requesting quote", { quoteRequest: quoteRequest as unknown as Record<string, unknown> });

  const quoteResponse = await OneClickService.getQuote(quoteRequest as any);

  const depositAddress = (quoteResponse as { depositAddress?: string }).depositAddress;
  if (!depositAddress) {
    throw new Error("Intents quote response missing depositAddress");
  }

  log.info("Got deposit address", { depositAddress });

  return { depositAddress, quoteResponse };
}

/**
 * Helper to create an IntentsQuoteRequest from bridgeBack config and flow context.
 * Reduces boilerplate in flow implementations.
 */
export function createBridgeBackQuoteRequest(
  bridgeBack: BridgeBackConfig,
  originAsset: string,
  amount: string,
  refundAddress: string,
): IntentsQuoteRequest {
  return {
    originAsset,
    destinationAsset: bridgeBack.destinationAsset,
    amount,
    recipient: bridgeBack.destinationAddress,
    refundAddress,
    slippageTolerance: bridgeBack.slippageTolerance,
  };
}
