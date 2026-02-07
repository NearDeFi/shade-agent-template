import type { Context } from "hono";
import { IntentChain } from "../../../queue/types";
import { config } from "../../../config";
import { fetchWithRetry } from "../../../utils/http";
import { isNativeEvmToken } from "../../../utils/common";
import { extractEvmTokenAddress, ETH_NATIVE_TOKEN } from "../../../constants";
import {
  deriveEvmAgentAddress,
  EVM_CHAIN_CONFIGS,
  EvmChainName,
} from "../../../utils/evmChains";
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

const log = createLogger("intents/quotes/evm");

export async function handleEvmSwapQuote(
  c: Context,
  payload: QuoteRequestBody,
  defuseQuoteFields: Record<string, unknown>,
  isDryRun: boolean,
  evmChain: EvmChainName,
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  const chainConfig = EVM_CHAIN_CONFIGS[evmChain];

  let agentEvmAddress: string | undefined;
  if (userDestination) {
    agentEvmAddress = await deriveEvmAgentAddress(userDestination);
  }

  const nativeDefuseAssetId = chainConfig.nativeDefuseAssetId;

  const bridgeQuoteRequest = {
    ...defuseQuoteFields,
    destinationAsset: nativeDefuseAssetId,
    dry: isDryRun,
    ...(agentEvmAddress && {
      recipient: agentEvmAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  log.info("EVM swap: requesting bridge leg quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    nativeDefuseAssetId,
    evmChain,
    amount: payload.amount,
    dry: isDryRun,
    intentsQuoteUrl: getIntentsApiBase(),
    agentRecipient: agentEvmAddress,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = await fetchDefuseQuote(bridgeQuoteRequest);
  } catch (err) {
    log.error("EVM swap: bridge quote failed", { err: String(err) });
    throw new AppError("upstream_error", (err as Error).message, { cause: err });
  }

  const baseQuote = intentsQuote.quote || {};
  const amountResult = extractQuoteAmount(baseQuote);
  if ("error" in amountResult) {
    throw new AppError("upstream_error", amountResult.error);
  }
  const bridgeAmount = amountResult.amount;

  const buyToken = extractEvmTokenAddress(payload.destinationAsset);
  const needsSwap = !isNativeEvmToken(buyToken);

  let finalAmountOut = bridgeAmount;

  if (needsSwap && config.zeroExApiKey && agentEvmAddress) {
    try {
      const zeroExUrl = new URL(`${chainConfig.zeroExBaseUrl}/swap/v1/price`);
      zeroExUrl.searchParams.set("sellToken", ETH_NATIVE_TOKEN);
      zeroExUrl.searchParams.set("buyToken", buyToken);
      zeroExUrl.searchParams.set("sellAmount", bridgeAmount);
      zeroExUrl.searchParams.set("takerAddress", agentEvmAddress);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.zeroExApiKey) {
        headers["0x-api-key"] = config.zeroExApiKey;
      }

      const previewRes = await fetchWithRetry(
        zeroExUrl.toString(),
        { headers },
        config.zeroExMaxAttempts,
        config.zeroExRetryBackoffMs,
      );

      if (previewRes.ok) {
        const preview = await previewRes.json();
        if (preview.buyAmount) {
          finalAmountOut = preview.buyAmount;
        }
      }
    } catch (err) {
      log.warn("EVM swap: 0x price preview failed (non-fatal)", { err: String(err) });
    }
  }

  const quoteId = generateQuoteId(baseQuote, "shade-evm");

  const enqueueIntent = !isDryRun
    ? buildAutoEnqueueIntent({
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: evmChain as IntentChain,
        intermediateAmount: bridgeAmount,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination: agentEvmAddress,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: {
          ...metadata,
          action: "evm-swap",
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
    logLabel: "EVM swap",
  });

  return c.json(buildQuoteResponse(intentsQuote, payload, isDryRun, baseQuote, quoteId, finalAmountOut, {
    evmChain,
    needsSwap,
  }));
}
