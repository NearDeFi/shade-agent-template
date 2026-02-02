import { Hono } from "hono";
import { RedisQueueClient } from "../queue/redis";
import { IntentMessage, IntentChain } from "../queue/types";
import { validateIntent } from "../queue/validation";
import { setStatus, getStatus } from "../state/status";
import { config } from "../config";
import { fetchWithRetry } from "../utils/http";
import {
  SOL_NATIVE_MINT,
  WRAP_NEAR_CONTRACT,
  extractSolanaMintAddress,
  extractEvmTokenAddress,
  ETH_NATIVE_TOKEN,
} from "../constants";
import { getSolDefuseAssetId, getDefuseAssetId } from "../utils/tokenMappings";
import {
  detectEvmChainFromAsset,
  deriveEvmAgentAddress,
  EVM_CHAIN_CONFIGS,
  EVM_SWAP_CHAINS,
  EvmChainName,
} from "../utils/evmChains";
import { deriveAgentPublicKey, getSolanaConnection } from "../utils/solana";
import { deriveNearImplicitAccount, NEAR_DEFAULT_PATH } from "../utils/chainSignature";
import { ensureImplicitAccountExists } from "../utils/nearMetaTx";
import { JsonRpcProvider } from "@near-js/providers";
import {
  isNearSignature,
  createIntentSigningMessage,
  validateIntentSignature,
} from "../utils/nearSignature";
import {
  createSolanaIntentSigningMessage,
  validateSolanaIntentSignature,
} from "../utils/solanaSignature";
import { UserSignature } from "../queue/types";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
  getNearTransactionStatus,
} from "../utils/near";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { deserializeInstruction, getAddressLookupTableAccounts } from "../flows/solSwap";
import {
  OneClickService,
  OpenAPI,
  QuoteRequest,
} from "@defuse-protocol/one-click-sdk-typescript";

const app = new Hono();
const queueClient = new RedisQueueClient();

type QuoteRequestBody = QuoteRequest & {
  // Additional fields for intent enqueuing (required when dry: false)
  sourceChain?: IntentChain;
  userDestination?: string;
  metadata?: Record<string, unknown>;
  // Kamino-specific fields
  kaminoDeposit?: {
    marketAddress: string;
    mintAddress: string;
  };
  // Burrow-specific fields
  burrowDeposit?: {
    tokenId: string;
    isCollateral?: boolean;
  };
  burrowWithdraw?: {
    tokenId: string;
    bridgeBack?: {
      destinationChain: string;
      destinationAddress: string;
      destinationAsset: string;
      slippageTolerance?: number;
    };
  };
  // Aave V3 fields
  aaveDeposit?: boolean;
  aaveWithdraw?: {
    underlyingAsset: string;
    bridgeBack?: {
      destinationChain: string;
      destinationAddress: string;
      destinationAsset: string;
      slippageTolerance?: number;
    };
  };
  // Morpho Blue fields
  morphoDeposit?: {
    marketId: string;
    loanToken: string;
    collateralToken: string;
    oracle: string;
    irm: string;
    lltv: string;
  };
  morphoWithdraw?: {
    marketId: string;
    loanToken: string;
    collateralToken: string;
    oracle: string;
    irm: string;
    lltv: string;
    bridgeBack?: {
      destinationChain: string;
      destinationAddress: string;
      destinationAsset: string;
      slippageTolerance?: number;
    };
  };
  // Sell flow fields: user sells a Solana token, agent bridges SOL out
  /** User's Solana wallet address (signer of the Jupiter sell TX) */
  userSourceAddress?: string;
  /** Destination chain for the sell output (e.g., "near", "ethereum") */
  sellDestinationChain?: string;
  /** User's address on the destination chain */
  sellDestinationAddress?: string;
  /** Defuse asset ID for the destination asset */
  sellDestinationAsset?: string;
  // NEAR sell flow fields: user sells a NEAR token, agent bridges wNEAR out
  /** User's NEAR wallet address (signals NEAR sell flow) */
  userNearAddress?: string;
};

interface IntentsQuoteResponse {
  timestamp?: string;
  signature?: string;
  quoteRequest?: Record<string, unknown>;
  quote: Record<string, any>;
}

/**
 * POST /api/intents - Enqueue an intent for processing
 *
 * SECURITY: This endpoint requires valid verification proof:
 * 1. Deposit-verified intents: Must have originTxHash + intentsDepositAddress
 *    (Used for Kamino deposits where the deposit tx is the authorization)
 * 2. Signature-verified intents: Must have valid userSignature (NEP-413)
 *    (Used for Kamino withdrawals where there's no deposit)
 *
 * Regular swaps should NOT use this endpoint - they are auto-enqueued
 * when requesting a quote with dry: false via POST /api/intents/quote
 */
app.post("/", async (c) => {
  if (!config.enableQueue) {
    return c.json({ error: "Queue consumer is disabled" }, 503);
  }

  let payload: IntentMessage;
  try {
    payload = await c.req.json<IntentMessage>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Verify the intent has valid authorization proof
  const hasDepositProof = payload.originTxHash && payload.intentsDepositAddress;
  const hasSignatureProof = payload.userSignature;

  if (!hasDepositProof && !hasSignatureProof) {
    console.warn("[intents] Rejected intent without verification proof", {
      intentId: payload.intentId,
      hasOriginTxHash: !!payload.originTxHash,
      hasDepositAddress: !!payload.intentsDepositAddress,
      hasSignature: !!payload.userSignature,
    });
    return c.json({
      error: "Intent requires verification: either originTxHash + intentsDepositAddress (for deposits) or userSignature (for withdrawals)"
    }, 403);
  }

  // If signature provided, verify it's valid AND bound to this intent
  if (hasSignatureProof && payload.userSignature) {
    let signatureType = "unknown";

    if (isNearSignature(payload.userSignature)) {
      signatureType = "near";

      if (!payload.nearPublicKey) {
        return c.json(
          { error: "nearPublicKey is required for NEAR signatures" },
          400,
        );
      }

      const expectedMessage = createIntentSigningMessage(payload);
      const result = validateIntentSignature(
        payload.userSignature,
        payload.nearPublicKey,
        expectedMessage,
      );

      if (!result.isValid) {
        console.warn("[intents] Rejected intent with invalid NEAR signature", {
          intentId: payload.intentId,
          publicKey: payload.userSignature.publicKey,
          error: result.error,
        });
        return c.json({ error: "Invalid userSignature" }, 403);
      }
    } else {
      signatureType = "solana";

      if (!payload.userDestination) {
        return c.json(
          { error: "userDestination is required for Solana signatures" },
          400,
        );
      }

      const expectedMessage = createSolanaIntentSigningMessage(payload);
      const result = validateSolanaIntentSignature(
        {
          message: payload.userSignature.message,
          signature: payload.userSignature.signature,
          publicKey: payload.userSignature.publicKey,
        },
        payload.userDestination,
        expectedMessage,
      );

      if (!result.isValid) {
        console.warn("[intents] Rejected intent with invalid Solana signature", {
          intentId: payload.intentId,
          publicKey: payload.userSignature.publicKey,
          error: result.error,
        });
        return c.json({ error: "Invalid userSignature" }, 403);
      }
    }

    console.info("[intents] Signature verified for intent", {
      intentId: payload.intentId,
      publicKey: payload.userSignature.publicKey,
      signatureType,
    });
  }

  // If deposit proof provided, log it (actual verification happens when processing)
  if (hasDepositProof) {
    console.info("[intents] Deposit-verified intent received", {
      intentId: payload.intentId,
      originTxHash: payload.originTxHash,
      depositAddress: payload.intentsDepositAddress,
    });
  }

  let validatedIntent;
  try {
    validatedIntent = validateIntent(payload);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  try {
    await queueClient.enqueueIntent(validatedIntent);
    await setStatus(validatedIntent.intentId, { state: "pending" });
    return c.json(
      { intentId: validatedIntent.intentId, state: "pending" },
      202,
    );
  } catch (err) {
    console.error("Failed to enqueue intent", err);
    return c.json({ error: "Failed to enqueue intent" }, 500);
  }
});

app.post("/quote", async (c) => {
  if (!config.intentsQuoteUrl && !OpenAPI.BASE) {
    return c.json({ error: "INTENTS_QUOTE_URL is not configured" }, 500);
  }

  let payload: QuoteRequestBody;
  try {
    payload = await c.req.json<QuoteRequestBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!payload.originAsset || !payload.destinationAsset || !payload.amount) {
    return c.json(
      { error: "originAsset, destinationAsset, and amount are required" },
      400,
    );
  }

  // Respect dry flag from request - dry: true for preview, dry: false for execution (to get depositAddress)
  const isDryRun = payload.dry !== false;

  // Extract custom fields that should NOT be sent to the Defuse API
  const { sourceChain, userDestination, metadata, kaminoDeposit, burrowDeposit, burrowWithdraw, aaveDeposit, aaveWithdraw, morphoDeposit, morphoWithdraw, userSourceAddress, sellDestinationChain, sellDestinationAddress, sellDestinationAsset, userNearAddress, ...defuseQuoteFields } = payload;

  if (config.intentsQuoteUrl) {
    OpenAPI.BASE = config.intentsQuoteUrl;
  }

  // For Burrow deposits, swap to target NEAR token via Intents, then deposit to Burrow
  // Check this BEFORE deriving Solana address since Burrow doesn't need it
  if (burrowDeposit) {
    return handleBurrowDepositQuote(c, payload, defuseQuoteFields, isDryRun, burrowDeposit, sourceChain, userDestination, metadata);
  }

  // For Burrow withdrawals, this is just for validation/preview - actual withdraw is triggered via POST /api/intents
  // The bridgeBack flow happens after withdrawal completes
  if (burrowWithdraw) {
    return handleBurrowWithdrawQuote(c, payload, defuseQuoteFields, isDryRun, burrowWithdraw, sourceChain, userDestination, metadata);
  }

  // Sell flow: user sells a Solana token → wSOL lands in agent → agent bridges SOL out
  if (userSourceAddress && sellDestinationChain) {
    return handleSellQuote(c, payload, isDryRun, userSourceAddress, sellDestinationChain, sellDestinationAddress, sellDestinationAsset);
  }

  // NEAR sell flow: user sells a NEAR token → agent swaps to wNEAR → bridges out via Defuse
  if (userNearAddress && sellDestinationChain) {
    return handleNearSellQuote(c, payload, isDryRun, userNearAddress, sellDestinationChain, sellDestinationAddress, sellDestinationAsset);
  }

  // Aave V3 deposit: bridge tokens to EVM chain, then deposit into Aave
  if (aaveDeposit) {
    return handleAaveDepositQuote(c, payload, defuseQuoteFields, isDryRun, sourceChain, userDestination, metadata);
  }

  // Aave V3 withdraw: validation/preview for withdraw flow
  if (aaveWithdraw) {
    return handleAaveWithdrawQuote(c, payload, isDryRun, aaveWithdraw, sourceChain, userDestination, metadata);
  }

  // Morpho Blue deposit: bridge tokens to EVM chain, then supply to Morpho
  if (morphoDeposit) {
    return handleMorphoDepositQuote(c, payload, defuseQuoteFields, isDryRun, morphoDeposit, sourceChain, userDestination, metadata);
  }

  // Morpho Blue withdraw: validation/preview for withdraw flow
  if (morphoWithdraw) {
    return handleMorphoWithdrawQuote(c, payload, isDryRun, morphoWithdraw, sourceChain, userDestination, metadata);
  }

  // EVM swap flow: destination asset is on an EVM chain
  const evmChain = detectEvmChainFromAsset(payload.destinationAsset);
  if (evmChain) {
    return handleEvmSwapQuote(c, payload, defuseQuoteFields, isDryRun, evmChain, sourceChain, userDestination, metadata);
  }

  // Derive the agent's Solana address for the 1-Click recipient (only needed for Solana flows)
  // Include userDestination in derivation path for custody isolation
  let agentSolanaAddress: string | undefined;
  if (userDestination) {
    console.log("userDestination", userDestination);
    const agentPubkey = await deriveAgentPublicKey(
      undefined,
      userDestination,
    );
    agentSolanaAddress = agentPubkey.toBase58();
  }

  // For Kamino deposits, use direct swap to target token (no Jupiter leg needed)
  // Intents delivers the target SPL token directly, then we deposit to Kamino
  if (kaminoDeposit) {
    return handleKaminoDepositQuote(c, payload, defuseQuoteFields, isDryRun, agentSolanaAddress, kaminoDeposit, sourceChain, userDestination, metadata);
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

  console.info("[intents/quote] requesting SOL leg quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    amount: payload.amount,
    slippageTolerance: payload.slippageTolerance,
    dry: isDryRun,
    intentsQuoteUrl: OpenAPI.BASE,
    agentRecipient: agentSolanaAddress,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(
      solQuoteRequest as any,
    )) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] intents quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }
  const baseQuote = intentsQuote.quote || {};
  const rawSolAmount =
    baseQuote.amountOut ||
    baseQuote.minAmountOut ||
    baseQuote.amountIn ||
    baseQuote.amount;
  if (!rawSolAmount) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  // Ensure solAmount is a clean integer string (no decimals, scientific notation, etc.)
  let solAmount: string;
  try {
    solAmount = BigInt(rawSolAmount).toString();
  } catch (e) {
    console.error("[intents/quote] Failed to parse solAmount as integer", { rawSolAmount });
    return c.json({ error: `Invalid amount format from intents: ${rawSolAmount}` }, 502);
  }

  // Extract raw Solana mint address from asset ID (handles 1cs_v1:sol:spl:mint format)
  const outputMint = extractSolanaMintAddress(payload.destinationAsset);

  const clusterParam = config.jupiterCluster
    ? `&cluster=${config.jupiterCluster}`
    : "";
  const jupiterUrl = `${config.jupiterBaseUrl}/quote?inputMint=${SOL_NATIVE_MINT}&outputMint=${encodeURIComponent(outputMint)}&amount=${solAmount}&slippageBps=${payload.slippageTolerance}${clusterParam}`;
  console.info("[intents/quote] requesting Jupiter leg", {
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
    console.error("[intents/quote] Jupiter quote failed", {
      status: jupiterRes.status,
      body,
    });
    return c.json(
      { error: `Jupiter quote failed: ${jupiterRes.status} ${body}` },
      502,
    );
  }
  const jupiterQuote = (await jupiterRes.json()) as { outAmount?: string };
  const outAmount = jupiterQuote.outAmount;
  if (!outAmount) {
    console.error("[intents/quote] Jupiter quote missing outAmount", jupiterQuote);
    return c.json({ error: "Jupiter quote missing outAmount" }, 502);
  }

  // Generate a quote ID for tracking (use 1-Click quoteId if available, otherwise generate one)
  const quoteId = baseQuote.quoteId || `shade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // When dry: false, auto-enqueue the intent (deposit verification happens via 1-Click API)
  // This prevents malicious actors from enqueuing fake intents without going through quote flow
  if (!isDryRun && config.enableQueue && baseQuote.depositAddress) {
    // Validate required fields for intent enqueuing
    if (!payload.sourceChain) {
      return c.json({ error: "sourceChain is required when dry: false" }, 400);
    }
    if (!payload.userDestination) {
      return c.json({ error: "userDestination is required when dry: false" }, 400);
    }

    try {
      // Use the agent address we derived earlier for the 1-Click recipient
      // This ensures the same address is used for delivery and signing
      const agentDestination = agentSolanaAddress!;

      const intentMessage: IntentMessage = {
        intentId: quoteId,
        sourceChain: payload.sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: "solana",
        intermediateAmount: solAmount,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination: payload.userDestination,
        agentDestination,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: payload.metadata,
      };

      const validatedIntent = validateIntent(intentMessage);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(validatedIntent.intentId, { state: "pending" });

      console.info("[intents/quote] Intent auto-enqueued", {
        intentId: quoteId,
        sourceChain: payload.sourceChain,
        depositAddress: baseQuote.depositAddress,
      });
    } catch (err) {
      console.error("[intents/quote] Failed to auto-enqueue intent", err);
      // Don't fail the quote request - intent can be retried
      // The 1-Click API will still track the swap via depositAddress
    }
  }

  return c.json({
    timestamp: intentsQuote.timestamp || new Date().toISOString(),
    signature: intentsQuote.signature || "",
    quoteRequest: {
      ...payload,
      dry: isDryRun,
    },
    quote: {
      ...baseQuote,
      quoteId,
      amountOut: outAmount,
      minAmountOut: outAmount,
      destinationAsset: payload.destinationAsset,
      // Include depositAddress and depositMemo from 1-Click quote (only present when dry: false)
      depositAddress: baseQuote.depositAddress,
      depositMemo: baseQuote.depositMemo,
    },
  });
});

/**
 * Handle Kamino deposit quote requests.
 * For Kamino deposits, we swap directly to the target SPL token via Intents (no Jupiter leg).
 * The flow is: Source asset -> Target SPL token (via Intents) -> Kamino deposit
 */
async function handleKaminoDepositQuote(
  c: any,
  payload: QuoteRequestBody,
  defuseQuoteFields: Omit<QuoteRequestBody, "sourceChain" | "userDestination" | "metadata" | "kaminoDeposit">,
  isDryRun: boolean,
  agentSolanaAddress: string | undefined,
  kaminoDeposit: { marketAddress: string; mintAddress: string },
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  // For Kamino deposits, swap directly to the destination asset (the SPL token to deposit)
  const directQuoteRequest = {
    ...defuseQuoteFields,
    dry: isDryRun,
    // Set recipient to the derived agent address so Intents delivers tokens there
    ...(agentSolanaAddress && {
      recipient: agentSolanaAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  console.info("[intents/quote] Kamino deposit: requesting direct quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    amount: payload.amount,
    slippageTolerance: payload.slippageTolerance,
    dry: isDryRun,
    intentsQuoteUrl: OpenAPI.BASE,
    agentRecipient: agentSolanaAddress,
    kaminoMarket: kaminoDeposit.marketAddress,
    kaminoMint: kaminoDeposit.mintAddress,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(
      directQuoteRequest as any,
    )) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] Kamino deposit: intents quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }

  const baseQuote = intentsQuote.quote || {};
  const rawAmountOut =
    baseQuote.amountOut ||
    baseQuote.minAmountOut ||
    baseQuote.amount;
  if (!rawAmountOut) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  // Ensure amount is a clean integer string
  let amountOut: string;
  try {
    amountOut = BigInt(rawAmountOut).toString();
  } catch (e) {
    console.error("[intents/quote] Failed to parse amountOut as integer", { rawAmountOut });
    return c.json({ error: `Invalid amount format from intents: ${rawAmountOut}` }, 502);
  }

  // Generate a quote ID for tracking
  const quoteId = baseQuote.quoteId || `shade-kamino-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // When dry: false, auto-enqueue the Kamino deposit intent
  if (!isDryRun && config.enableQueue && baseQuote.depositAddress) {
    if (!sourceChain) {
      return c.json({ error: "sourceChain is required when dry: false" }, 400);
    }
    if (!userDestination) {
      return c.json({ error: "userDestination is required when dry: false" }, 400);
    }

    try {
      const agentDestination = agentSolanaAddress!;

      // Build Kamino-specific metadata
      const intentMetadata = {
        ...metadata,
        action: "kamino-deposit",
        marketAddress: kaminoDeposit.marketAddress,
        mintAddress: kaminoDeposit.mintAddress,
        targetDefuseAssetId: payload.destinationAsset,
        useIntents: true,
      };

      const intentMessage: IntentMessage = {
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: "solana",
        intermediateAmount: amountOut,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: intentMetadata,
      };

      const validatedIntent = validateIntent(intentMessage);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(validatedIntent.intentId, { state: "pending" });

      console.info("[intents/quote] Kamino deposit intent auto-enqueued", {
        intentId: quoteId,
        sourceChain,
        depositAddress: baseQuote.depositAddress,
        kaminoMarket: kaminoDeposit.marketAddress,
      });
    } catch (err) {
      console.error("[intents/quote] Failed to auto-enqueue Kamino intent", err);
    }
  }

  return c.json({
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
    },
  });
}

/**
 * Handle Burrow deposit quote requests.
 * For Burrow deposits, we swap directly to the target NEAR token via Intents.
 * The flow is: Source asset -> Target NEAR token (via Intents) -> Burrow deposit
 */
async function handleBurrowDepositQuote(
  c: any,
  payload: QuoteRequestBody,
  defuseQuoteFields: Omit<QuoteRequestBody, "sourceChain" | "userDestination" | "metadata" | "kaminoDeposit" | "burrowDeposit">,
  isDryRun: boolean,
  burrowDeposit: { tokenId: string; isCollateral?: boolean },
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  // Derive the agent's NEAR address for the recipient
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

  // When not a dry run, ensure the implicit account exists so it can receive tokens
  if (!isDryRun && agentNearAddress && agentPublicKey) {
    const nearRpcUrl = config.nearRpcUrls[0] || "https://rpc.mainnet.near.org";
    const provider = new JsonRpcProvider({ url: nearRpcUrl });
    await ensureImplicitAccountExists(provider, agentNearAddress, agentPublicKey);
  }

  // For Burrow deposits, swap directly to the destination asset (the NEAR token to deposit)
  const directQuoteRequest = {
    ...defuseQuoteFields,
    dry: isDryRun,
    // Set recipient to the derived agent NEAR address so Intents delivers tokens there
    ...(agentNearAddress && {
      recipient: agentNearAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  console.info("[intents/quote] Burrow deposit: requesting direct quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    amount: payload.amount,
    slippageTolerance: payload.slippageTolerance,
    dry: isDryRun,
    intentsQuoteUrl: OpenAPI.BASE,
    agentRecipient: agentNearAddress,
    burrowTokenId: burrowDeposit.tokenId,
    isCollateral: burrowDeposit.isCollateral,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(
      directQuoteRequest as any,
    )) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] Burrow deposit: intents quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }

  const baseQuote = intentsQuote.quote || {};
  const rawAmountOut =
    baseQuote.amountOut ||
    baseQuote.minAmountOut ||
    baseQuote.amount;
  if (!rawAmountOut) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  // Ensure amount is a clean integer string
  let amountOut: string;
  try {
    amountOut = BigInt(rawAmountOut).toString();
  } catch (e) {
    console.error("[intents/quote] Failed to parse amountOut as integer", { rawAmountOut });
    return c.json({ error: `Invalid amount format from intents: ${rawAmountOut}` }, 502);
  }

  // Generate a quote ID for tracking
  const quoteId = baseQuote.quoteId || `shade-burrow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // When dry: false, auto-enqueue the Burrow deposit intent
  if (!isDryRun && config.enableQueue && baseQuote.depositAddress) {
    if (!sourceChain) {
      return c.json({ error: "sourceChain is required when dry: false" }, 400);
    }
    if (!userDestination) {
      return c.json({ error: "userDestination is required when dry: false" }, 400);
    }

    try {
      const agentDestination = agentNearAddress!;

      // Build Burrow-specific metadata
      const intentMetadata = {
        ...metadata,
        action: "burrow-deposit",
        tokenId: burrowDeposit.tokenId,
        isCollateral: burrowDeposit.isCollateral ?? false,
        targetDefuseAssetId: payload.destinationAsset,
        useIntents: true,
      };

      const intentMessage: IntentMessage = {
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: "near",
        intermediateAmount: amountOut,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: intentMetadata,
      };

      const validatedIntent = validateIntent(intentMessage);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(validatedIntent.intentId, { state: "pending" });

      console.info("[intents/quote] Burrow deposit intent auto-enqueued", {
        intentId: quoteId,
        sourceChain,
        depositAddress: baseQuote.depositAddress,
        burrowTokenId: burrowDeposit.tokenId,
      });
    } catch (err) {
      console.error("[intents/quote] Failed to auto-enqueue Burrow intent", err);
    }
  }

  return c.json({
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
    },
  });
}

/**
 * Handle Burrow withdraw quote requests.
 * For Burrow withdrawals with bridgeBack, we need to get a quote for the bridge portion.
 * The flow is: Burrow withdraw -> Target NEAR token -> Bridge to destination chain (via Intents)
 */
async function handleBurrowWithdrawQuote(
  c: any,
  payload: QuoteRequestBody,
  defuseQuoteFields: Omit<QuoteRequestBody, "sourceChain" | "userDestination" | "metadata" | "kaminoDeposit" | "burrowDeposit" | "burrowWithdraw">,
  isDryRun: boolean,
  burrowWithdraw: { tokenId: string; bridgeBack?: { destinationChain: string; destinationAddress: string; destinationAsset: string; slippageTolerance?: number } },
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  // For withdrawals without bridgeBack, just return a simple response
  // The actual withdrawal is triggered via POST /api/intents with userSignature
  if (!burrowWithdraw.bridgeBack) {
    const quoteId = `shade-burrow-withdraw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return c.json({
      timestamp: new Date().toISOString(),
      signature: "",
      quoteRequest: {
        ...payload,
        dry: isDryRun,
      },
      quote: {
        quoteId,
        amountOut: payload.amount, // Withdraw amount = output amount (no swap)
        minAmountOut: payload.amount,
        tokenId: burrowWithdraw.tokenId,
        message: "Submit withdraw intent via POST /api/intents with userSignature",
      },
    });
  }

  // For withdrawals with bridgeBack, get a quote for the bridge portion
  const { destinationAddress, destinationAsset, slippageTolerance } = burrowWithdraw.bridgeBack;

  // Convert NEAR token ID to Defuse asset ID for the origin
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

  console.info("[intents/quote] Burrow withdraw bridgeBack: requesting quote", {
    originAsset,
    destinationAsset,
    amount: payload.amount,
    slippageTolerance: slippageTolerance ?? 300,
    dry: isDryRun,
    intentsQuoteUrl: OpenAPI.BASE,
    burrowTokenId: burrowWithdraw.tokenId,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(
      bridgeQuoteRequest as any,
    )) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] Burrow withdraw bridgeBack: intents quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }

  const baseQuote = intentsQuote.quote || {};
  const rawAmountOut =
    baseQuote.amountOut ||
    baseQuote.minAmountOut ||
    baseQuote.amount;
  if (!rawAmountOut) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  // Ensure amount is a clean integer string
  let amountOut: string;
  try {
    amountOut = BigInt(rawAmountOut).toString();
  } catch (e) {
    console.error("[intents/quote] Failed to parse amountOut as integer", { rawAmountOut });
    return c.json({ error: `Invalid amount format from intents: ${rawAmountOut}` }, 502);
  }

  // Generate a quote ID for tracking
  const quoteId = baseQuote.quoteId || `shade-burrow-withdraw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // When dry: false, auto-enqueue the Burrow withdraw intent
  if (!isDryRun && config.enableQueue) {
    if (!sourceChain) {
      return c.json({ error: "sourceChain is required when dry: false" }, 400);
    }
    if (!userDestination) {
      return c.json({ error: "userDestination is required when dry: false" }, 400);
    }

    // Note: For withdrawals, we don't auto-enqueue here because they require userSignature
    // The frontend must POST to /api/intents with the signed intent
    console.info("[intents/quote] Burrow withdraw quote ready - frontend must submit signed intent", {
      quoteId,
      tokenId: burrowWithdraw.tokenId,
      bridgeBack: burrowWithdraw.bridgeBack,
    });
  }

  return c.json({
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
      destinationAsset,
      tokenId: burrowWithdraw.tokenId,
      // Note: depositAddress here is for the bridge portion, not the Burrow withdraw
      bridgeDepositAddress: baseQuote.depositAddress,
      depositMemo: baseQuote.depositMemo,
      message: "Submit withdraw intent via POST /api/intents with userSignature",
    },
  });
}

/**
 * Handle sell quote requests.
 * Sell flow: User sells a custom Solana token via Jupiter (user-signed TX),
 * output lands in the agent wallet as wSOL, then agent bridges SOL out via Defuse.
 *
 * Returns an unsigned Jupiter swap transaction for the user to sign and broadcast.
 */
async function handleSellQuote(
  c: any,
  payload: QuoteRequestBody,
  isDryRun: boolean,
  userSourceAddress: string,
  sellDestinationChain: string,
  sellDestinationAddress: string | undefined,
  sellDestinationAsset: string | undefined,
) {
  if (!sellDestinationAddress) {
    return c.json({ error: "sellDestinationAddress is required for sell quotes" }, 400);
  }
  if (!sellDestinationAsset) {
    return c.json({ error: "sellDestinationAsset is required for sell quotes" }, 400);
  }

  // originAsset = the Solana token the user is selling
  // The user's wallet will sign the Jupiter TX
  const inputMint = extractSolanaMintAddress(payload.originAsset);

  // Derive agent Solana address from userSourceAddress (custody isolation)
  const agentPubkey = await deriveAgentPublicKey(undefined, userSourceAddress);
  const agentSolanaAddress = agentPubkey.toBase58();

  // Compute agent's wSOL ATA — Jupiter will send output here
  const agentWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    agentPubkey,
    true,
    TOKEN_PROGRAM_ID,
  );

  console.info("[intents/quote] Sell quote: requesting Jupiter quote", {
    inputMint,
    outputMint: SOL_NATIVE_MINT,
    amount: payload.amount,
    userSourceAddress,
    agentSolanaAddress,
    agentWsolAta: agentWsolAta.toBase58(),
    sellDestinationChain,
  });

  // Get Jupiter quote: custom token → wSOL
  const clusterParam = config.jupiterCluster ? `&cluster=${config.jupiterCluster}` : "";
  const jupiterQuoteUrl = `${config.jupiterBaseUrl}/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${SOL_NATIVE_MINT}&amount=${payload.amount}&slippageBps=${payload.slippageTolerance || 300}${clusterParam}`;

  const jupiterQuoteRes = await fetchWithRetry(
    jupiterQuoteUrl,
    undefined,
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );
  if (!jupiterQuoteRes.ok) {
    const body = await jupiterQuoteRes.text().catch(() => "");
    console.error("[intents/quote] Sell: Jupiter quote failed", { status: jupiterQuoteRes.status, body });
    return c.json({ error: `Jupiter quote failed: ${jupiterQuoteRes.status} ${body}` }, 502);
  }
  const jupiterQuote = await jupiterQuoteRes.json();

  const outAmount = jupiterQuote.outAmount;
  if (!outAmount) {
    console.error("[intents/quote] Sell: Jupiter quote missing outAmount", jupiterQuote);
    return c.json({ error: "Jupiter quote missing outAmount" }, 502);
  }

  // Get Jupiter swap-instructions with user as signer, agent wSOL ATA as destination
  const swapInstructionsRes = await fetchWithRetry(
    `${config.jupiterBaseUrl}/swap-instructions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: jupiterQuote,
        userPublicKey: userSourceAddress,
        destinationTokenAccount: agentWsolAta.toBase58(),
        wrapAndUnwrapSol: false, // Keep wSOL wrapped — agent unwraps later
        dynamicComputeUnitLimit: true,
        computeUnitPriceMicroLamports: "auto",
      }),
    },
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );

  if (!swapInstructionsRes.ok) {
    const body = await swapInstructionsRes.text().catch(() => "");
    console.error("[intents/quote] Sell: Jupiter swap-instructions failed", { status: swapInstructionsRes.status, body });
    return c.json({ error: `Jupiter swap-instructions failed: ${swapInstructionsRes.status} ${body}` }, 502);
  }

  const swapInstructions = await swapInstructionsRes.json();

  // Assemble the unsigned transaction
  const instructions = [];

  if (swapInstructions.computeBudgetInstructions) {
    for (const ix of swapInstructions.computeBudgetInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
  }
  if (swapInstructions.setupInstructions) {
    for (const ix of swapInstructions.setupInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
  }
  if (swapInstructions.swapInstruction) {
    instructions.push(deserializeInstruction(swapInstructions.swapInstruction));
  }
  if (swapInstructions.cleanupInstruction) {
    instructions.push(deserializeInstruction(swapInstructions.cleanupInstruction));
  }
  if (swapInstructions.otherInstructions) {
    for (const ix of swapInstructions.otherInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
  }

  const connection = getSolanaConnection();
  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    connection,
    swapInstructions.addressLookupTableAddresses || [],
  );

  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: new PublicKey(userSourceAddress),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts);

  const unsignedTx = new VersionedTransaction(messageV0);
  const unsignedTxBase64 = Buffer.from(unsignedTx.serialize()).toString("base64");

  // Generate an intent ID for tracking
  const intentId = `shade-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Save to Redis as awaiting_user_tx with full intent data
  await setStatus(intentId, {
    state: "awaiting_user_tx",
    detail: "Waiting for user to sign and broadcast Jupiter swap transaction",
    intentData: {
      intentId,
      sourceChain: "solana",
      sourceAsset: payload.originAsset,
      sourceAmount: payload.amount,
      destinationChain: sellDestinationChain as IntentChain,
      intermediateAsset: SOL_NATIVE_MINT,
      finalAsset: sellDestinationAsset,
      slippageBps: payload.slippageTolerance || 300,
      userDestination: userSourceAddress,
      agentDestination: agentSolanaAddress,
      metadata: {
        action: "sol-bridge-out",
        userSourceAddress,
        userTxHash: "",
        userTxConfirmed: false,
        destinationChain: sellDestinationChain,
        destinationAddress: sellDestinationAddress,
        destinationAsset: sellDestinationAsset,
        slippageTolerance: payload.slippageTolerance,
      },
    },
  });

  console.info("[intents/quote] Sell quote ready", {
    intentId,
    inputMint,
    outAmount,
    agentSolanaAddress,
    sellDestinationChain,
  });

  return c.json({
    timestamp: new Date().toISOString(),
    signature: "",
    quoteRequest: {
      ...payload,
      dry: isDryRun,
    },
    quote: {
      quoteId: intentId,
      intentId,
      amountOut: outAmount,
      minAmountOut: outAmount,
      unsignedTx: unsignedTxBase64,
      direction: "sell",
      agentSolanaAddress,
      sellDestinationChain,
      sellDestinationAddress,
      sellDestinationAsset,
    },
  });
}

/**
 * Handle NEAR sell quote requests.
 * NEAR sell flow: User transfers a custom NEAR token to the agent via ft_transfer_call,
 * then agent swaps token → wNEAR via Ref Finance and bridges wNEAR out via Defuse.
 *
 * Returns the transfer params the user needs to call ft_transfer_call.
 */
async function handleNearSellQuote(
  c: any,
  payload: QuoteRequestBody,
  isDryRun: boolean,
  userNearAddress: string,
  sellDestinationChain: string,
  sellDestinationAddress: string | undefined,
  sellDestinationAsset: string | undefined,
) {
  if (!sellDestinationAddress) {
    return c.json({ error: "sellDestinationAddress is required for NEAR sell quotes" }, 400);
  }
  if (!sellDestinationAsset) {
    return c.json({ error: "sellDestinationAsset is required for NEAR sell quotes" }, 400);
  }

  // originAsset = the NEAR token the user is selling (NEP-141 contract ID)
  // Strip nep141: prefix if present
  const tokenContract = payload.originAsset.startsWith("nep141:")
    ? payload.originAsset.slice(7)
    : payload.originAsset;

  // Derive agent NEAR address from userNearAddress (custody isolation)
  const userAgent = await deriveNearAgentAccount(NEAR_DEFAULT_PATH, userNearAddress);
  const agentNearAddress = userAgent.accountId;

  // Ensure the implicit account exists so it can receive tokens
  await ensureNearAccountFunded(agentNearAddress);

  console.info("[intents/quote] NEAR sell quote", {
    tokenContract,
    amount: payload.amount,
    userNearAddress,
    agentNearAddress,
    sellDestinationChain,
  });

  // Generate an intent ID for tracking
  const intentId = `shade-near-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Save to Redis as awaiting_user_tx with full intent data
  await setStatus(intentId, {
    state: "awaiting_user_tx",
    detail: "Waiting for user to execute ft_transfer_call to agent NEAR account",
    intentData: {
      intentId,
      sourceChain: "near",
      sourceAsset: payload.originAsset,
      sourceAmount: payload.amount,
      destinationChain: sellDestinationChain as IntentChain,
      intermediateAsset: WRAP_NEAR_CONTRACT,
      finalAsset: sellDestinationAsset,
      slippageBps: payload.slippageTolerance || 300,
      userDestination: userNearAddress,
      agentDestination: agentNearAddress,
      metadata: {
        action: "near-bridge-out",
        userNearAddress,
        userTxHash: "",
        userTxConfirmed: false,
        tokenId: tokenContract,
        destinationChain: sellDestinationChain,
        destinationAddress: sellDestinationAddress,
        destinationAsset: sellDestinationAsset,
        slippageTolerance: payload.slippageTolerance,
      },
    },
  });

  console.info("[intents/quote] NEAR sell quote ready", {
    intentId,
    tokenContract,
    agentNearAddress,
    sellDestinationChain,
  });

  return c.json({
    timestamp: new Date().toISOString(),
    signature: "",
    quoteRequest: {
      ...payload,
      dry: isDryRun,
    },
    quote: {
      quoteId: intentId,
      intentId,
      amountOut: payload.amount,
      minAmountOut: payload.amount,
      direction: "sell",
      agentNearAddress,
      transferParams: {
        tokenContract,
        method: "ft_transfer_call",
        args: {
          receiver_id: agentNearAddress,
          amount: payload.amount,
          msg: "",
        },
      },
      sellDestinationChain,
      sellDestinationAddress,
      sellDestinationAsset,
    },
  });
}

/**
 * Handle EVM swap quote requests.
 * EVM swap flow: Source asset -> native EVM token (via Intents/Defuse) -> target EVM token (via 0x)
 * For same-token swaps (just bridging), the 0x leg is skipped.
 */
async function handleEvmSwapQuote(
  c: any,
  payload: QuoteRequestBody,
  defuseQuoteFields: Omit<QuoteRequestBody, "sourceChain" | "userDestination" | "metadata" | "kaminoDeposit" | "burrowDeposit" | "burrowWithdraw" | "userSourceAddress" | "sellDestinationChain" | "sellDestinationAddress" | "sellDestinationAsset" | "userNearAddress">,
  isDryRun: boolean,
  evmChain: EvmChainName,
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  const chainConfig = EVM_CHAIN_CONFIGS[evmChain];

  // Derive the agent's EVM address for the recipient
  let agentEvmAddress: string | undefined;
  if (userDestination) {
    agentEvmAddress = await deriveEvmAgentAddress(userDestination);
  }

  // Bridge leg: swap source asset to the native EVM token via Defuse/Intents
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

  console.info("[intents/quote] EVM swap: requesting bridge leg quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    nativeDefuseAssetId,
    evmChain,
    amount: payload.amount,
    dry: isDryRun,
    intentsQuoteUrl: OpenAPI.BASE,
    agentRecipient: agentEvmAddress,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(
      bridgeQuoteRequest as any,
    )) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] EVM swap: bridge quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }

  const baseQuote = intentsQuote.quote || {};
  const rawBridgeAmount =
    baseQuote.amountOut ||
    baseQuote.minAmountOut ||
    baseQuote.amountIn ||
    baseQuote.amount;
  if (!rawBridgeAmount) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  let bridgeAmount: string;
  try {
    bridgeAmount = BigInt(rawBridgeAmount).toString();
  } catch (e) {
    console.error("[intents/quote] EVM swap: failed to parse bridgeAmount", { rawBridgeAmount });
    return c.json({ error: `Invalid amount format from intents: ${rawBridgeAmount}` }, 502);
  }

  // Check if we need a swap leg (destination asset != native token)
  const buyToken = extractEvmTokenAddress(payload.destinationAsset);
  const needsSwap = !isNativeEvmToken(buyToken);

  let finalAmountOut = bridgeAmount;

  // Optional: 0x preview quote for swap leg (native → target token)
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
      console.warn("[intents/quote] EVM swap: 0x price preview failed (non-fatal)", err);
    }
  }

  const quoteId = baseQuote.quoteId || `shade-evm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // When dry: false, auto-enqueue the EVM swap intent
  if (!isDryRun && config.enableQueue && baseQuote.depositAddress) {
    if (!sourceChain) {
      return c.json({ error: "sourceChain is required when dry: false" }, 400);
    }
    if (!userDestination) {
      return c.json({ error: "userDestination is required when dry: false" }, 400);
    }

    try {
      const agentDestination = agentEvmAddress!;

      const intentMessage: IntentMessage = {
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: evmChain as IntentChain,
        intermediateAmount: bridgeAmount,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: {
          ...metadata,
          action: "evm-swap",
        },
      };

      const validatedIntent = validateIntent(intentMessage);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(validatedIntent.intentId, { state: "pending" });

      console.info("[intents/quote] EVM swap intent auto-enqueued", {
        intentId: quoteId,
        sourceChain,
        evmChain,
        depositAddress: baseQuote.depositAddress,
      });
    } catch (err) {
      console.error("[intents/quote] Failed to auto-enqueue EVM swap intent", err);
    }
  }

  return c.json({
    timestamp: intentsQuote.timestamp || new Date().toISOString(),
    signature: intentsQuote.signature || "",
    quoteRequest: {
      ...payload,
      dry: isDryRun,
    },
    quote: {
      ...baseQuote,
      quoteId,
      amountOut: finalAmountOut,
      minAmountOut: finalAmountOut,
      destinationAsset: payload.destinationAsset,
      depositAddress: baseQuote.depositAddress,
      depositMemo: baseQuote.depositMemo,
      evmChain,
      needsSwap,
    },
  });
}

// ─── Aave V3 Quote Handlers ─────────────────────────────────────────────────────

/**
 * Handle Aave V3 deposit quote requests.
 * Bridge tokens to the target EVM chain, then deposit into Aave V3 Pool.
 */
async function handleAaveDepositQuote(
  c: any,
  payload: QuoteRequestBody,
  defuseQuoteFields: Record<string, unknown>,
  isDryRun: boolean,
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  const evmChain = detectEvmChainFromAsset(payload.destinationAsset);
  if (!evmChain || !["ethereum", "base", "arbitrum"].includes(evmChain)) {
    return c.json({ error: "Aave V3 deposit requires destination on ethereum, base, or arbitrum" }, 400);
  }

  const chainConfig = EVM_CHAIN_CONFIGS[evmChain];
  let agentEvmAddress: string | undefined;
  if (userDestination) {
    agentEvmAddress = await deriveEvmAgentAddress(userDestination);
  }

  // Bridge to the destination asset (the ERC-20 token to deposit into Aave)
  const bridgeQuoteRequest = {
    ...defuseQuoteFields,
    dry: isDryRun,
    ...(agentEvmAddress && {
      recipient: agentEvmAddress,
      recipientType: "DESTINATION_CHAIN" as const,
    }),
  };

  console.info("[intents/quote] Aave deposit: requesting bridge quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    evmChain,
    amount: payload.amount,
    dry: isDryRun,
    agentRecipient: agentEvmAddress,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(bridgeQuoteRequest as any)) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] Aave deposit: bridge quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }

  const baseQuote = intentsQuote.quote || {};
  const rawAmountOut = baseQuote.amountOut || baseQuote.minAmountOut || baseQuote.amount;
  if (!rawAmountOut) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  let amountOut: string;
  try {
    amountOut = BigInt(rawAmountOut).toString();
  } catch {
    return c.json({ error: `Invalid amount format from intents: ${rawAmountOut}` }, 502);
  }

  const quoteId = baseQuote.quoteId || `shade-aave-deposit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!isDryRun && config.enableQueue && baseQuote.depositAddress) {
    if (!sourceChain) return c.json({ error: "sourceChain is required when dry: false" }, 400);
    if (!userDestination) return c.json({ error: "userDestination is required when dry: false" }, 400);

    try {
      const intentMessage: IntentMessage = {
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: evmChain as IntentChain,
        intermediateAmount: amountOut,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination: agentEvmAddress!,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: { ...metadata, action: "aave-deposit" },
      };

      const validatedIntent = validateIntent(intentMessage);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(validatedIntent.intentId, { state: "pending" });

      console.info("[intents/quote] Aave deposit intent auto-enqueued", {
        intentId: quoteId,
        sourceChain,
        evmChain,
        depositAddress: baseQuote.depositAddress,
      });
    } catch (err) {
      console.error("[intents/quote] Failed to auto-enqueue Aave deposit intent", err);
    }
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
      destinationAsset: payload.destinationAsset,
      depositAddress: baseQuote.depositAddress,
      depositMemo: baseQuote.depositMemo,
      evmChain,
      protocol: "aave-v3",
    },
  });
}

/**
 * Handle Aave V3 withdraw quote requests.
 * For withdrawals, the frontend must submit a signed intent via POST /api/intents.
 */
async function handleAaveWithdrawQuote(
  c: any,
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

// ─── Morpho Blue Quote Handlers ─────────────────────────────────────────────────

/**
 * Handle Morpho Blue deposit quote requests.
 * Bridge tokens to the target EVM chain, then supply to Morpho Blue market.
 */
async function handleMorphoDepositQuote(
  c: any,
  payload: QuoteRequestBody,
  defuseQuoteFields: Record<string, unknown>,
  isDryRun: boolean,
  morphoDeposit: { marketId: string; loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string },
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  const evmChain = detectEvmChainFromAsset(payload.destinationAsset);
  if (!evmChain || !["ethereum", "base"].includes(evmChain)) {
    return c.json({ error: "Morpho Blue deposit requires destination on ethereum or base" }, 400);
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

  console.info("[intents/quote] Morpho deposit: requesting bridge quote", {
    originAsset: payload.originAsset,
    destinationAsset: payload.destinationAsset,
    evmChain,
    amount: payload.amount,
    dry: isDryRun,
    agentRecipient: agentEvmAddress,
    morphoMarketId: morphoDeposit.marketId,
  });

  let intentsQuote: IntentsQuoteResponse;
  try {
    intentsQuote = (await OneClickService.getQuote(bridgeQuoteRequest as any)) as IntentsQuoteResponse;
  } catch (err) {
    console.error("[intents/quote] Morpho deposit: bridge quote failed", err);
    return c.json({ error: (err as Error).message }, 502);
  }

  const baseQuote = intentsQuote.quote || {};
  const rawAmountOut = baseQuote.amountOut || baseQuote.minAmountOut || baseQuote.amount;
  if (!rawAmountOut) {
    return c.json({ error: "Intents quote missing amountOut" }, 502);
  }

  let amountOut: string;
  try {
    amountOut = BigInt(rawAmountOut).toString();
  } catch {
    return c.json({ error: `Invalid amount format from intents: ${rawAmountOut}` }, 502);
  }

  const quoteId = baseQuote.quoteId || `shade-morpho-deposit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!isDryRun && config.enableQueue && baseQuote.depositAddress) {
    if (!sourceChain) return c.json({ error: "sourceChain is required when dry: false" }, 400);
    if (!userDestination) return c.json({ error: "userDestination is required when dry: false" }, 400);

    try {
      const intentMessage: IntentMessage = {
        intentId: quoteId,
        sourceChain,
        sourceAsset: payload.originAsset,
        sourceAmount: payload.amount,
        destinationChain: evmChain as IntentChain,
        intermediateAmount: amountOut,
        finalAsset: payload.destinationAsset,
        slippageBps: payload.slippageTolerance,
        userDestination,
        agentDestination: agentEvmAddress!,
        intentsDepositAddress: baseQuote.depositAddress,
        depositMemo: baseQuote.depositMemo,
        metadata: {
          ...metadata,
          action: "morpho-deposit",
          marketId: morphoDeposit.marketId,
          loanToken: morphoDeposit.loanToken,
          collateralToken: morphoDeposit.collateralToken,
          oracle: morphoDeposit.oracle,
          irm: morphoDeposit.irm,
          lltv: morphoDeposit.lltv,
        },
      };

      const validatedIntent = validateIntent(intentMessage);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(validatedIntent.intentId, { state: "pending" });

      console.info("[intents/quote] Morpho deposit intent auto-enqueued", {
        intentId: quoteId,
        sourceChain,
        evmChain,
        depositAddress: baseQuote.depositAddress,
        morphoMarketId: morphoDeposit.marketId,
      });
    } catch (err) {
      console.error("[intents/quote] Failed to auto-enqueue Morpho deposit intent", err);
    }
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
      destinationAsset: payload.destinationAsset,
      depositAddress: baseQuote.depositAddress,
      depositMemo: baseQuote.depositMemo,
      evmChain,
      protocol: "morpho-blue",
      morphoMarketId: morphoDeposit.marketId,
    },
  });
}

/**
 * Handle Morpho Blue withdraw quote requests.
 * For withdrawals, the frontend must submit a signed intent via POST /api/intents.
 */
async function handleMorphoWithdrawQuote(
  c: any,
  payload: QuoteRequestBody,
  isDryRun: boolean,
  morphoWithdraw: { marketId: string; loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string; bridgeBack?: { destinationChain: string; destinationAddress: string; destinationAsset: string; slippageTolerance?: number } },
  sourceChain: IntentChain | undefined,
  userDestination: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  const quoteId = `shade-morpho-withdraw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return c.json({
    timestamp: new Date().toISOString(),
    signature: "",
    quoteRequest: { ...payload, dry: isDryRun },
    quote: {
      quoteId,
      amountOut: payload.amount,
      minAmountOut: payload.amount,
      morphoMarketId: morphoWithdraw.marketId,
      protocol: "morpho-blue",
      message: "Submit withdraw intent via POST /api/intents with userSignature",
    },
  });
}

function isNativeEvmToken(address: string): boolean {
  return (
    address.toLowerCase() === ETH_NATIVE_TOKEN.toLowerCase() ||
    address === "0x0000000000000000000000000000000000000000"
  );
}

/**
 * POST /api/intents/:intentId/confirm
 *
 * Confirm a user-signed sell transaction.
 * After the user signs and broadcasts the sell TX (Jupiter for Solana, ft_transfer for NEAR),
 * this endpoint verifies it on-chain and enqueues the bridge-out intent.
 */
app.post("/:intentId/confirm", async (c) => {
  if (!config.enableQueue) {
    return c.json({ error: "Queue consumer is disabled" }, 503);
  }

  const intentId = c.req.param("intentId");

  let body: { txHash: string };
  try {
    body = await c.req.json<{ txHash: string }>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.txHash) {
    return c.json({ error: "txHash is required" }, 400);
  }

  // Verify the intent exists and is in the correct state
  const status = await getStatus(intentId);
  if (!status) {
    return c.json({ error: "Intent not found" }, 404);
  }
  if (status.state !== "awaiting_user_tx") {
    return c.json({
      error: `Intent is in state '${status.state}', expected 'awaiting_user_tx'`,
    }, 409);
  }
  if (!status.intentData) {
    return c.json({ error: "Intent data missing from status" }, 500);
  }

  const intentData = status.intentData;
  const meta = intentData.metadata as any;

  // Dispatch verification based on the action type
  if (meta.action === "near-bridge-out") {
    // ─── NEAR sell: verify ft_transfer on NEAR ───────────────────────────
    const userNearAddress = meta.userNearAddress;
    if (!userNearAddress) {
      return c.json({ error: "Missing userNearAddress in intent metadata" }, 500);
    }

    let txResult;
    try {
      txResult = await getNearTransactionStatus(body.txHash, userNearAddress);
    } catch (err) {
      console.error("[intents/confirm] Failed to fetch NEAR transaction", { txHash: body.txHash, err });
      return c.json({ error: "Failed to verify NEAR transaction on-chain" }, 502);
    }

    if (!txResult.success) {
      return c.json({ error: "NEAR transaction failed on-chain" }, 400);
    }

    // Security: verify the TX is an ft_transfer or ft_transfer_call to the agent's NEAR account
    const agentAccount = await deriveNearAgentAccount(NEAR_DEFAULT_PATH, userNearAddress);
    const agentNearAddress = agentAccount.accountId;

    const hasFtTransfer = txResult.actions.some((a) => {
      const isFtMethod = a.methodName === "ft_transfer" || a.methodName === "ft_transfer_call";
      const toAgent = a.args?.receiver_id === agentNearAddress;
      return isFtMethod && toAgent;
    });

    if (!hasFtTransfer) {
      console.warn("[intents/confirm] NEAR TX is not an ft_transfer to agent", {
        intentId,
        txHash: body.txHash,
        agentNearAddress,
        receiverId: txResult.receiverId,
        actions: txResult.actions,
      });
      return c.json({ error: "Transaction is not an ft_transfer to the expected agent address" }, 403);
    }

    // Update intent metadata with confirmed TX hash and enqueue
    meta.userTxHash = body.txHash;
    meta.userTxConfirmed = true;
    intentData.metadata = meta;

    try {
      const validatedIntent = validateIntent(intentData);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(intentId, {
        state: "processing",
        detail: "NEAR transaction confirmed, bridge-out in progress",
        intentData: validatedIntent,
      });

      console.info("[intents/confirm] NEAR sell intent confirmed and enqueued", {
        intentId,
        txHash: body.txHash,
        agentNearAddress,
      });

      return c.json({
        intentId,
        state: "processing",
        txHash: body.txHash,
      });
    } catch (err) {
      console.error("[intents/confirm] Failed to enqueue confirmed NEAR intent", err);
      return c.json({ error: "Failed to enqueue intent" }, 500);
    }
  } else {
    // ─── Solana sell: verify Jupiter TX on Solana ────────────────────────
    const connection = getSolanaConnection();
    let txInfo;
    try {
      txInfo = await connection.getTransaction(body.txHash, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      console.error("[intents/confirm] Failed to fetch transaction", { txHash: body.txHash, err });
      return c.json({ error: "Failed to verify transaction on-chain" }, 502);
    }

    if (!txInfo) {
      return c.json({ error: "Transaction not found on-chain. It may not be confirmed yet." }, 404);
    }

    if (txInfo.meta?.err) {
      return c.json({ error: `Transaction failed on-chain: ${JSON.stringify(txInfo.meta.err)}` }, 400);
    }

    // Security: verify the agent address appears in the TX account keys
    const agentPubkey = await deriveAgentPublicKey(undefined, meta.userSourceAddress);
    const agentAddress = agentPubkey.toBase58();
    const accountKeys = txInfo.transaction.message.getAccountKeys();
    const accountAddresses = [];
    for (let i = 0; i < accountKeys.length; i++) {
      accountAddresses.push(accountKeys.get(i)?.toBase58());
    }

    // Check agent wSOL ATA (the destination token account)
    const agentWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      agentPubkey,
      true,
      TOKEN_PROGRAM_ID,
    );

    const agentInvolved = accountAddresses.includes(agentAddress) || accountAddresses.includes(agentWsolAta.toBase58());
    if (!agentInvolved) {
      console.warn("[intents/confirm] Agent address not found in TX account keys", {
        intentId,
        txHash: body.txHash,
        agentAddress,
        agentWsolAta: agentWsolAta.toBase58(),
      });
      return c.json({ error: "Transaction does not involve the expected agent address" }, 403);
    }

    // Update intent metadata with confirmed TX hash and enqueue
    meta.userTxHash = body.txHash;
    meta.userTxConfirmed = true;
    intentData.metadata = meta;

    try {
      const validatedIntent = validateIntent(intentData);
      await queueClient.enqueueIntent(validatedIntent);
      await setStatus(intentId, {
        state: "processing",
        detail: "User transaction confirmed, bridge-out in progress",
        intentData: validatedIntent,
      });

      console.info("[intents/confirm] Sell intent confirmed and enqueued", {
        intentId,
        txHash: body.txHash,
        agentAddress,
      });

      return c.json({
        intentId,
        state: "processing",
        txHash: body.txHash,
      });
    } catch (err) {
      console.error("[intents/confirm] Failed to enqueue confirmed intent", err);
      return c.json({ error: "Failed to enqueue intent" }, 500);
    }
  }
});

export default app;
