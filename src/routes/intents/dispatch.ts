import type { Context } from "hono";
import type { QuoteRequestBody } from "./types";
import { detectEvmChainFromAsset } from "../../utils/evmChains";
import { handleSwapQuote } from "./quotes/swap";
import { handleKaminoDepositQuote } from "./quotes/kamino";
import {
  handleBurrowDepositQuote,
  handleBurrowWithdrawQuote,
} from "./quotes/burrow";
import {
  handleSellQuote,
  handleNearSellQuote,
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

interface QuoteDispatchContext {
  c: Context;
  payload: QuoteRequestBody;
  isDryRun: boolean;
  sourceChain: QuoteRequestBody["sourceChain"];
  userDestination: QuoteRequestBody["userDestination"];
  metadata: QuoteRequestBody["metadata"];
  defuseQuoteFields: Record<string, unknown>;
  evmChain: ReturnType<typeof detectEvmChainFromAsset>;
}

interface QuoteDispatchRoute {
  run: (ctx: QuoteDispatchContext) => Promise<Response | null>;
}

export async function dispatchIntentQuote(
  c: Context,
  payload: QuoteRequestBody,
): Promise<Response> {
  const isDryRun = payload.dry !== false;
  const {
    sourceChain,
    userDestination,
    metadata,
    kaminoDeposit,
    burrowDeposit,
    burrowWithdraw,
    aaveDeposit,
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

  const dispatchCtx: QuoteDispatchContext = {
    c,
    payload,
    isDryRun,
    sourceChain,
    userDestination,
    metadata,
    defuseQuoteFields,
    evmChain: detectEvmChainFromAsset(payload.destinationAsset),
  };

  const routes: QuoteDispatchRoute[] = [
    {
      run: async (ctx) => {
        if (!burrowDeposit) return null;
        return handleBurrowDepositQuote(
          ctx.c,
          ctx.payload,
          ctx.defuseQuoteFields,
          ctx.isDryRun,
          burrowDeposit,
          ctx.sourceChain,
          ctx.userDestination,
          ctx.metadata,
        );
      },
    },
    {
      run: async (ctx) => {
        if (!burrowWithdraw) return null;
        return handleBurrowWithdrawQuote(
          ctx.c,
          ctx.payload,
          ctx.defuseQuoteFields,
          ctx.isDryRun,
          burrowWithdraw,
          ctx.sourceChain,
          ctx.userDestination,
          ctx.metadata,
        );
      },
    },
    {
      run: async (ctx) => {
        if (!userSourceAddress || !sellDestinationChain) return null;
        return handleSellQuote(
          ctx.c,
          ctx.payload,
          ctx.isDryRun,
          userSourceAddress,
          sellDestinationChain,
          sellDestinationAddress,
          sellDestinationAsset,
        );
      },
    },
    {
      run: async (ctx) => {
        if (!userNearAddress || !sellDestinationChain) return null;
        return handleNearSellQuote(
          ctx.c,
          ctx.payload,
          ctx.isDryRun,
          userNearAddress,
          sellDestinationChain,
          sellDestinationAddress,
          sellDestinationAsset,
        );
      },
    },
    {
      run: async (ctx) => {
        if (!aaveDeposit) return null;
        return handleAaveDepositQuote(
          ctx.c,
          ctx.payload,
          ctx.defuseQuoteFields,
          ctx.isDryRun,
          ctx.sourceChain,
          ctx.userDestination,
          ctx.metadata,
        );
      },
    },
    {
      run: async (ctx) => {
        if (!aaveWithdraw) return null;
        return handleAaveWithdrawQuote(
          ctx.c,
          ctx.payload,
          ctx.isDryRun,
          aaveWithdraw,
          ctx.sourceChain,
          ctx.userDestination,
          ctx.metadata,
        );
      },
    },
    {
      run: async (ctx) => {
        if (!morphoDeposit) return null;
        return handleMorphoDepositQuote(
          ctx.c,
          ctx.payload,
          ctx.defuseQuoteFields,
          ctx.isDryRun,
          morphoDeposit,
          ctx.sourceChain,
          ctx.userDestination,
          ctx.metadata,
        );
      },
    },
    {
      run: async (ctx) => {
        if (!morphoWithdraw) return null;
        return handleMorphoWithdrawQuote(
          ctx.c,
          ctx.payload,
          ctx.isDryRun,
          morphoWithdraw,
          ctx.sourceChain,
          ctx.userDestination,
          ctx.metadata,
        );
      },
    },
    {
      run: async (ctx) => {
        if (!ctx.evmChain) return null;
        return handleEvmSwapQuote(
          ctx.c,
          ctx.payload,
          ctx.defuseQuoteFields,
          ctx.isDryRun,
          ctx.evmChain,
          ctx.sourceChain,
          ctx.userDestination,
          ctx.metadata,
        );
      },
    },
    {
      run: async (ctx) => {
        if (!kaminoDeposit) return null;
        return handleKaminoDepositQuote(
          ctx.c,
          ctx.payload,
          ctx.defuseQuoteFields,
          ctx.isDryRun,
          kaminoDeposit,
          ctx.sourceChain,
          ctx.userDestination,
          ctx.metadata,
        );
      },
    },
    {
      run: async (ctx) => handleSwapQuote(
        ctx.c,
        ctx.payload,
        ctx.defuseQuoteFields,
        ctx.isDryRun,
        ctx.sourceChain,
        ctx.userDestination,
        ctx.metadata,
      ),
    },
  ];

  for (const route of routes) {
    const response = await route.run(dispatchCtx);
    if (response) {
      return response;
    }
  }

  // routes include a fallback, but keep a hard guard for future edits.
  return handleSwapQuote(
    c,
    payload,
    defuseQuoteFields,
    isDryRun,
    sourceChain,
    userDestination,
    metadata,
  );
}
