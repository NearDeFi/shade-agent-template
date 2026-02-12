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

const log = createLogger("intents/quotes/evm");

export async function handleEvmSwapQuote(
  ctx: QuoteContext,
  evmChain: EvmChainName,
) {
  const { c, payload, defuseQuoteFields, isDryRun, sourceChain, userDestination, metadata } = ctx;
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

  const { intentsQuote, baseQuote, amountOut: bridgeAmount } = await fetchAndExtractQuote(
    bridgeQuoteRequest,
    "EVM swap",
  );

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
