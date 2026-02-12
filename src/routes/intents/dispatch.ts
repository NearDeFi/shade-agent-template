import type { Context } from "hono";
import type { QuoteRequestBody } from "./types";
import { AppError } from "../../errors/appError";
import { detectEvmChainFromAsset } from "../../utils/evmChains";
import type { QuoteContext } from "./helpers";
import { handleSwapQuote } from "./quotes/swap";
import { handleKaminoDepositQuote } from "./quotes/kamino";
import {
  handleBurrowDepositQuote,
  handleBurrowWithdrawQuote,
} from "./quotes/burrow";
import {
  handleSellQuote,
  handleNearSellQuote,
  type SellParams,
  type NearSellParams,
} from "./quotes/sell";
import { handleEvmSwapQuote } from "./quotes/evm";
import {
  handleAaveDepositQuote,
  handleAaveWithdrawQuote,
} from "./quotes/aave";
import {
  handleMorphoDepositQuote,
  handleMorphoWithdrawQuote,
} from "./quotes/morpho";

type QuoteMode =
  | "burrowDeposit"
  | "burrowWithdraw"
  | "solanaSell"
  | "nearSell"
  | "aaveDeposit"
  | "aaveWithdraw"
  | "morphoDeposit"
  | "morphoWithdraw"
  | "kaminoDeposit"
  | "evmSwap"
  | "swap";

function resolveQuoteMode(payload: QuoteRequestBody, evmChain: ReturnType<typeof detectEvmChainFromAsset>): QuoteMode {
  const modeCandidates: QuoteMode[] = [];

  if (payload.burrowDeposit) modeCandidates.push("burrowDeposit");
  if (payload.burrowWithdraw) modeCandidates.push("burrowWithdraw");
  if (payload.userSourceAddress && payload.sellDestinationChain) modeCandidates.push("solanaSell");
  if (payload.userNearAddress && payload.sellDestinationChain) modeCandidates.push("nearSell");
  if (payload.aaveDeposit) modeCandidates.push("aaveDeposit");
  if (payload.aaveWithdraw) modeCandidates.push("aaveWithdraw");
  if (payload.morphoDeposit) modeCandidates.push("morphoDeposit");
  if (payload.morphoWithdraw) modeCandidates.push("morphoWithdraw");
  if (payload.kaminoDeposit) modeCandidates.push("kaminoDeposit");

  if (modeCandidates.length > 1) {
    throw new AppError(
      "invalid_request",
      `Conflicting quote modes in request: ${modeCandidates.join(", ")}`,
    );
  }

  if (modeCandidates.length === 1) {
    return modeCandidates[0];
  }

  if (evmChain) {
    return "evmSwap";
  }

  return "swap";
}

export async function dispatchIntentQuote(
  c: Context,
  payload: QuoteRequestBody,
): Promise<Response> {
  const isDryRun = payload.dry !== false;
  const evmChain = detectEvmChainFromAsset(payload.destinationAsset);
  const mode = resolveQuoteMode(payload, evmChain);

  const {
    sourceChain,
    userDestination,
    metadata,
    kaminoDeposit,
    burrowDeposit,
    burrowWithdraw,
    aaveWithdraw,
    morphoDeposit,
    morphoWithdraw,
    userSourceAddress,
    sellDestinationChain,
    sellDestinationAddress,
    sellDestinationAsset,
    userNearAddress,
    ...defuseQuoteFields
  } = payload;

  const ctx: QuoteContext = {
    c,
    payload,
    defuseQuoteFields,
    isDryRun,
    sourceChain,
    userDestination,
    metadata,
  };

  switch (mode) {
    case "burrowDeposit":
      return handleBurrowDepositQuote(ctx, burrowDeposit!);
    case "burrowWithdraw":
      return handleBurrowWithdrawQuote(ctx, burrowWithdraw!);
    case "solanaSell":
      return handleSellQuote(ctx, {
        userSourceAddress: userSourceAddress!,
        sellDestinationChain: sellDestinationChain!,
        sellDestinationAddress,
        sellDestinationAsset,
      });
    case "nearSell":
      return handleNearSellQuote(ctx, {
        userNearAddress: userNearAddress!,
        sellDestinationChain: sellDestinationChain!,
        sellDestinationAddress,
        sellDestinationAsset,
      });
    case "aaveDeposit":
      return handleAaveDepositQuote(ctx);
    case "aaveWithdraw":
      return handleAaveWithdrawQuote(ctx, aaveWithdraw!);
    case "morphoDeposit":
      return handleMorphoDepositQuote(ctx, morphoDeposit!);
    case "morphoWithdraw":
      return handleMorphoWithdrawQuote(ctx, morphoWithdraw!);
    case "kaminoDeposit":
      return handleKaminoDepositQuote(ctx, kaminoDeposit!);
    case "evmSwap":
      return handleEvmSwapQuote(ctx, evmChain!);
    case "swap":
    default:
      return handleSwapQuote(ctx);
  }
}
