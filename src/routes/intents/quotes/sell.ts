import { address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { IntentChain } from "../../../queue/types";
import { config } from "../../../config";
import { fetchWithRetry } from "../../../utils/http";
import { SOL_NATIVE_MINT, WRAP_NEAR_CONTRACT, extractSolanaMintAddress } from "../../../constants";
import { setStatus } from "../../../state/status";
import {
  deriveAgentPublicKey,
  getSolanaRpc,
  deserializeInstruction,
  getAddressLookupTableAccounts,
  buildAndCompileTransaction,
} from "../../../utils/solana";
import { createDummySigner } from "../../../utils/chainSignature";
import { deriveNearImplicitAccount, NEAR_DEFAULT_PATH } from "../../../utils/chainSignature";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
} from "../../../utils/near";
import type { QuoteContext } from "../helpers";
import { createLogger } from "../../../utils/logger";
import { AppError } from "../../../errors/appError";

const log = createLogger("intents/quotes/sell");

export interface SellParams {
  userSourceAddress: string;
  sellDestinationChain: string;
  sellDestinationAddress?: string;
  sellDestinationAsset?: string;
}

export interface NearSellParams {
  userNearAddress: string;
  sellDestinationChain: string;
  sellDestinationAddress?: string;
  sellDestinationAsset?: string;
}

export async function handleSellQuote(
  ctx: QuoteContext,
  sellParams: SellParams,
) {
  const { c, payload, isDryRun } = ctx;
  const { userSourceAddress, sellDestinationChain, sellDestinationAddress, sellDestinationAsset } = sellParams;
  if (!sellDestinationAddress) {
    throw new AppError("invalid_request", "sellDestinationAddress is required for sell quotes");
  }
  if (!sellDestinationAsset) {
    throw new AppError("invalid_request", "sellDestinationAsset is required for sell quotes");
  }

  const inputMint = extractSolanaMintAddress(payload.originAsset);

  const agentSolanaAddress = await deriveAgentPublicKey(undefined, userSourceAddress);

  const nativeMintAddr = address("So11111111111111111111111111111111111111112");
  const [agentWsolAta] = await findAssociatedTokenPda({
    mint: nativeMintAddr,
    owner: agentSolanaAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  log.info("Sell quote: requesting Jupiter quote", {
    inputMint,
    outputMint: SOL_NATIVE_MINT,
    amount: payload.amount,
    userSourceAddress,
    agentSolanaAddress,
    agentWsolAta,
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
        destinationTokenAccount: agentWsolAta,
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

  const rpc = getSolanaRpc();
  const addressLookupTables = await getAddressLookupTableAccounts(
    rpc,
    swapInstructions.addressLookupTableAddresses || [],
  );

  // Build an unsigned transaction for the user's wallet to sign.
  // We use buildAndCompileTransaction with the user as fee payer.
  const compiledTx = await buildAndCompileTransaction({
    instructions,
    feePayer: address(userSourceAddress),
    rpc,
    addressLookupTables,
  });

  // Serialize to wire format for wallet: [num_sigs (1 byte)] + [zero-filled signatures] + [message]
  const sigAddresses = Object.keys(compiledTx.signatures);
  const numSigs = sigAddresses.length;
  const totalSigBytes = numSigs * 64;
  const serialized = new Uint8Array(1 + totalSigBytes + compiledTx.messageBytes.length);
  serialized[0] = numSigs;
  // Signatures are left as zero-filled (unsigned)
  serialized.set(compiledTx.messageBytes, 1 + totalSigBytes);
  const unsignedTxBase64 = Buffer.from(serialized).toString("base64");

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
  ctx: QuoteContext,
  nearSellParams: NearSellParams,
) {
  const { c, payload, isDryRun } = ctx;
  const { userNearAddress, sellDestinationChain, sellDestinationAddress, sellDestinationAsset } = nearSellParams;
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
