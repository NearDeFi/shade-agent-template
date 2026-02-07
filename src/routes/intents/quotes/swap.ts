import type { Context } from "hono";
import { IntentChain } from "../../../queue/types";
import { config } from "../../../config";
import { fetchWithRetry } from "../../../utils/http";
import { SOL_NATIVE_MINT, extractSolanaMintAddress } from "../../../constants";
import { getSolDefuseAssetId } from "../../../utils/tokenMappings";
import { deriveAgentPublicKey } from "../../../utils/solana";
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
import { getIntentsApiBase } from "../../../infra/intentsApi";
import { AppError } from "../../../errors/appError";

const log = createLogger("intents/quotes/swap");

export async function handleSwapQuote(
  c: Context,
  payload: QuoteRequestBody,
  defuseQuoteFields: Record<string, unknown>,
  isDryRun: boolean,
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  // Derive the agent's Solana address for the 1-Click recipient (only needed for Solana flows)
  // Include userDestination in derivation path for custody isolation
  let agentSolanaAddress: string | undefined;
  if (userDestination) {
    log.info("userDestination", { userDestination });
    const agentPubkey = await deriveAgentPublicKey(
      undefined,
      userDestination,
    );
    agentSolanaAddress = agentPubkey.toBase58();
  }

  // Regular two-leg swap: First swap origin asset to SOL via Intents, then SOL to final token via Jupiter
  // Use Defuse asset ID format for the SOL destination
  const solDefuseAssetId = getSolDefuseAssetId();
  const solQuoteRequest = {
    ...defuseQuoteFields,
    destinationAsset: solDefuseAssetId,
    dry: isDryRun,
    // Set recipient to the derived agent address so 1-Click delivers SOL there
    ...(agentSolanaAddress && {
      recipient: agentSolanaAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  log.info("requesting SOL leg quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    amount: payload.amount,
    slippageTolerance: payload.slippageTolerance,
    dry: isDryRun,
    intentsQuoteUrl: getIntentsApiBase(),
    agentRecipient: agentSolanaAddress,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = await fetchDefuseQuote(solQuoteRequest);
  } catch (err) {
    log.error("intents quote failed", { err: String(err) });
    throw new AppError("upstream_error", (err as Error).message, { cause: err });
  }
  const baseQuote = intentsQuote.quote || {};
  const amountResult = extractQuoteAmount(baseQuote);
  if ("error" in amountResult) {
    throw new AppError("upstream_error", amountResult.error);
  }
  const solAmount = amountResult.amount;

  // Extract raw Solana mint address from asset ID (handles 1cs_v1:sol:spl:mint format)
  const outputMint = extractSolanaMintAddress(payload.destinationAsset);

  const clusterParam = config.jupiterCluster
    ? `&cluster=${config.jupiterCluster}`
    : "";
  const jupiterUrl = `${config.jupiterBaseUrl}/quote?inputMint=${SOL_NATIVE_MINT}&outputMint=${encodeURIComponent(outputMint)}&amount=${solAmount}&slippageBps=${payload.slippageTolerance ?? 300}${clusterParam}`;
  log.info("requesting Jupiter leg", {
    url: jupiterUrl,
  });
  const jupiterRes = await fetchWithRetry(
    jupiterUrl,
    undefined,
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );
  if (!jupiterRes.ok) {
    const body = await jupiterRes.text().catch(() => "");
    log.error("Jupiter quote failed", {
      status: jupiterRes.status,
      body,
    });
    throw new AppError("upstream_error", `Jupiter quote failed: ${jupiterRes.status} ${body}`);
  }
  const jupiterQuote = (await jupiterRes.json()) as { outAmount?: string };
  const outAmount = jupiterQuote.outAmount;
  if (!outAmount) {
    log.error("Jupiter quote missing outAmount", { jupiterQuote });
    throw new AppError("upstream_error", "Jupiter quote missing outAmount");
  }

  // Generate a quote ID for tracking (use 1-Click quoteId if available, otherwise generate one)
  const quoteId = generateQuoteId(baseQuote);

  const enqueueIntent = !isDryRun
    ? buildAutoEnqueueIntent({
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: "solana",
        intermediateAmount: solAmount,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination: agentSolanaAddress,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata,
      })
    : undefined;

  // When dry: false, auto-enqueue the intent (deposit verification happens via 1-Click API)
  // This prevents malicious actors from enqueuing fake intents without going through quote flow
  await tryAutoEnqueue({
    isDryRun,
    depositAddress: baseQuote.depositAddress,
    sourceChain,
    userDestination,
    intent: enqueueIntent,
    flowCatalog,
    logLabel: "swap",
  });

  return c.json(buildQuoteResponse(intentsQuote, payload, isDryRun, baseQuote, quoteId, outAmount));
}
