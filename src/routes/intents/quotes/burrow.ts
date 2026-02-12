import { config } from "../../../config";
import { getDefuseAssetId } from "../../../utils/tokenMappings";
import { deriveNearImplicitAccount, NEAR_DEFAULT_PATH } from "../../../utils/chainSignature";
import { ensureImplicitAccountExists } from "../../../utils/nearMetaTx";
import { getNearProvider } from "../../../utils/near";
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
import { AppError } from "../../../errors/appError";

const log = createLogger("intents/quotes/burrow");

export async function handleBurrowDepositQuote(
  ctx: QuoteContext,
  burrowDeposit: { tokenId: string; isCollateral?: boolean },
) {
  const { c, payload, defuseQuoteFields, isDryRun, sourceChain, userDestination, metadata } = ctx;
  let agentNearAddress: string | undefined;
  let agentPublicKey: string | undefined;
  if (userDestination) {
    const { accountId, publicKey } = await deriveNearImplicitAccount(
      NEAR_DEFAULT_PATH,
      undefined,
      userDestination,
    );
    agentNearAddress = accountId;
    agentPublicKey = publicKey;
  }

  if (!isDryRun && agentNearAddress && agentPublicKey) {
    await ensureImplicitAccountExists(getNearProvider(), agentNearAddress, agentPublicKey);
  }

  const directQuoteRequest = {
    ...defuseQuoteFields,
    dry: isDryRun,
    ...(agentNearAddress && {
      recipient: agentNearAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  log.info("Burrow deposit: requesting direct quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    amount: payload.amount,
    slippageTolerance: payload.slippageTolerance,
    dry: isDryRun,
    intentsQuoteUrl: getIntentsApiBase(),
    agentRecipient: agentNearAddress,
    burrowTokenId: burrowDeposit.tokenId,
    isCollateral: burrowDeposit.isCollateral,
  });

  const { intentsQuote, baseQuote, amountOut } = await fetchAndExtractQuote(
    directQuoteRequest,
    "Burrow deposit",
  );

  const quoteId = generateQuoteId(baseQuote, "shade-burrow");

  const enqueueIntent = !isDryRun
    ? buildAutoEnqueueIntent({
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: "near",
        intermediateAmount: amountOut,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination: agentNearAddress,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: {
          ...metadata,
          action: "burrow-deposit",
          tokenId: burrowDeposit.tokenId,
          isCollateral: burrowDeposit.isCollateral ?? false,
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
    logLabel: "Burrow deposit",
  });

  return c.json(buildQuoteResponse(intentsQuote, payload, isDryRun, baseQuote, quoteId, amountOut));
}

export async function handleBurrowWithdrawQuote(
  ctx: QuoteContext,
  burrowWithdraw: { tokenId: string; bridgeBack?: { destinationChain: string; destinationAddress: string; destinationAsset: string; slippageTolerance?: number } },
) {
  const { c, payload, defuseQuoteFields, isDryRun, sourceChain, userDestination, metadata } = ctx;
  if (!burrowWithdraw.bridgeBack) {
    const quoteId = `shade-burrow-withdraw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return c.json({
      timestamp: new Date().toISOString(),
      signature: "",
      quoteRequest: { ...payload, dry: isDryRun },
      quote: {
        quoteId,
        amountOut: payload.amount,
        minAmountOut: payload.amount,
        tokenId: burrowWithdraw.tokenId,
        message: "Submit withdraw intent via POST /api/intents with userSignature",
      },
    });
  }

  const { destinationAddress, destinationAsset, slippageTolerance } = burrowWithdraw.bridgeBack;
  const originAsset = getDefuseAssetId("near", burrowWithdraw.tokenId) || `nep141:${burrowWithdraw.tokenId}`;

  const bridgeQuoteRequest = {
    ...defuseQuoteFields,
    originAsset,
    destinationAsset,
    dry: isDryRun,
    recipient: destinationAddress,
    recipientType: "DESTINATION_CHAIN" as const,
    slippageTolerance: slippageTolerance ?? 300,
  };

  log.info("Burrow withdraw bridgeBack: requesting quote", {
    originAsset,
    destinationAsset,
    amount: payload.amount,
    slippageTolerance: slippageTolerance ?? 300,
    dry: isDryRun,
    intentsQuoteUrl: getIntentsApiBase(),
    burrowTokenId: burrowWithdraw.tokenId,
  });

  const { intentsQuote, baseQuote, amountOut } = await fetchAndExtractQuote(
    bridgeQuoteRequest,
    "Burrow withdraw bridgeBack",
  );

  const quoteId = generateQuoteId(baseQuote, "shade-burrow-withdraw");

  if (!isDryRun && config.enableQueue) {
    if (!sourceChain) {
      throw new AppError("invalid_request", "sourceChain is required when dry: false");
    }
    if (!userDestination) {
      throw new AppError("invalid_request", "userDestination is required when dry: false");
    }

    log.info("Burrow withdraw quote ready - frontend must submit signed intent", {
      quoteId,
      tokenId: burrowWithdraw.tokenId,
      bridgeBack: burrowWithdraw.bridgeBack,
    });
  }

  return c.json({
    timestamp: intentsQuote.timestamp || new Date().toISOString(),
    signature: intentsQuote.signature || "",
    quoteRequest: { ...payload, dry: isDryRun },
    quote: {
      ...baseQuote,
      quoteId,
      amountOut,
      minAmountOut: amountOut,
      destinationAsset,
      tokenId: burrowWithdraw.tokenId,
      bridgeDepositAddress: baseQuote.depositAddress,
      depositMemo: baseQuote.depositMemo,
      message: "Submit withdraw intent via POST /api/intents with userSignature",
    },
  });
}
