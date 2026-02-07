import type { Context } from "hono";
import { IntentChain } from "../../../queue/types";
import { config } from "../../../config";
import { fetchWithRetry } from "../../../utils/http";
import { SOL_NATIVE_MINT, WRAP_NEAR_CONTRACT, extractSolanaMintAddress } from "../../../constants";
import { setStatus } from "../../../state/status";
import {
  deriveAgentPublicKey,
  getSolanaConnection,
  deserializeInstruction,
  getAddressLookupTableAccounts,
} from "../../../utils/solana";
import { deriveNearImplicitAccount, NEAR_DEFAULT_PATH } from "../../../utils/chainSignature";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
} from "../../../utils/near";
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
import type { QuoteRequestBody } from "../types";
import { createLogger } from "../../../utils/logger";
import { AppError } from "../../../errors/appError";

const log = createLogger("intents/quotes/sell");

export async function handleSellQuote(
  c: Context,
  payload: QuoteRequestBody,
  isDryRun: boolean,
  userSourceAddress: string,
  sellDestinationChain: string,
  sellDestinationAddress: string | undefined,
  sellDestinationAsset: string | undefined,
) {
  if (!sellDestinationAddress) {
    throw new AppError("invalid_request", "sellDestinationAddress is required for sell quotes");
  }
  if (!sellDestinationAsset) {
    throw new AppError("invalid_request", "sellDestinationAsset is required for sell quotes");
  }

  const inputMint = extractSolanaMintAddress(payload.originAsset);

  const agentPubkey = await deriveAgentPublicKey(undefined, userSourceAddress);
  const agentSolanaAddress = agentPubkey.toBase58();

  const agentWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    agentPubkey,
    true,
    TOKEN_PROGRAM_ID,
  );

  log.info("Sell quote: requesting Jupiter quote", {
    inputMint,
    outputMint: SOL_NATIVE_MINT,
    amount: payload.amount,
    userSourceAddress,
    agentSolanaAddress,
    agentWsolAta: agentWsolAta.toBase58(),
    sellDestinationChain,
  });

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
    log.error("Sell: Jupiter quote failed", { status: jupiterQuoteRes.status, body });
    throw new AppError("upstream_error", `Jupiter quote failed: ${jupiterQuoteRes.status} ${body}`);
  }
  const jupiterQuote = await jupiterQuoteRes.json();

  const outAmount = jupiterQuote.outAmount;
  if (!outAmount) {
    log.error("Sell: Jupiter quote missing outAmount", { jupiterQuote });
    throw new AppError("upstream_error", "Jupiter quote missing outAmount");
  }

  const swapInstructionsRes = await fetchWithRetry(
    `${config.jupiterBaseUrl}/swap-instructions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: jupiterQuote,
        userPublicKey: userSourceAddress,
        destinationTokenAccount: agentWsolAta.toBase58(),
        wrapAndUnwrapSol: false,
        dynamicComputeUnitLimit: true,
        computeUnitPriceMicroLamports: "auto",
      }),
    },
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );

  if (!swapInstructionsRes.ok) {
    const body = await swapInstructionsRes.text().catch(() => "");
    log.error("Sell: Jupiter swap-instructions failed", { status: swapInstructionsRes.status, body });
    throw new AppError(
      "upstream_error",
      `Jupiter swap-instructions failed: ${swapInstructionsRes.status} ${body}`,
    );
  }

  const swapInstructions = await swapInstructionsRes.json();

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

  const intentId = `shade-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!isDryRun) {
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
  }

  log.info("Sell quote ready", {
    intentId,
    inputMint,
    outAmount,
    agentSolanaAddress,
    sellDestinationChain,
  });

  return c.json({
    timestamp: new Date().toISOString(),
    signature: "",
    quoteRequest: { ...payload, dry: isDryRun },
    quote: {
      quoteId: intentId,
      intentId,
      amountOut: outAmount,
      minAmountOut: outAmount,
      unsignedTx: unsignedTxBase64,
      direction: "sell",
      confirmRequired: !isDryRun,
      agentSolanaAddress,
      sellDestinationChain,
      sellDestinationAddress,
      sellDestinationAsset,
    },
  });
}

export async function handleNearSellQuote(
  c: Context,
  payload: QuoteRequestBody,
  isDryRun: boolean,
  userNearAddress: string,
  sellDestinationChain: string,
  sellDestinationAddress: string | undefined,
  sellDestinationAsset: string | undefined,
) {
  if (!sellDestinationAddress) {
    throw new AppError("invalid_request", "sellDestinationAddress is required for NEAR sell quotes");
  }
  if (!sellDestinationAsset) {
    throw new AppError("invalid_request", "sellDestinationAsset is required for NEAR sell quotes");
  }

  const tokenContract = payload.originAsset.startsWith("nep141:")
    ? payload.originAsset.slice(7)
    : payload.originAsset;

  const userAgent = await deriveNearAgentAccount(NEAR_DEFAULT_PATH, userNearAddress);
  const agentNearAddress = userAgent.accountId;

  if (!isDryRun) {
    await ensureNearAccountFunded(agentNearAddress);
  }

  log.info("NEAR sell quote", {
    tokenContract,
    amount: payload.amount,
    userNearAddress,
    agentNearAddress,
    sellDestinationChain,
  });

  const intentId = `shade-near-sell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!isDryRun) {
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
  }

  log.info("NEAR sell quote ready", {
    intentId,
    tokenContract,
    agentNearAddress,
    sellDestinationChain,
  });

  return c.json({
    timestamp: new Date().toISOString(),
    signature: "",
    quoteRequest: { ...payload, dry: isDryRun },
    quote: {
      quoteId: intentId,
      intentId,
      amountOut: payload.amount,
      minAmountOut: payload.amount,
      direction: "sell",
      confirmRequired: !isDryRun,
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
