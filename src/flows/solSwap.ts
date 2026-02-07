import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { extractSolanaMintAddress } from "../constants";
import { ValidatedIntent } from "../queue/types";
import {
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  getSolanaConnection,
  signAndBroadcastSingleSigner,
  deserializeInstruction,
  getAddressLookupTableAccounts,
} from "../utils/solana";
import { fetchWithRetry } from "../utils/http";
import { requireUserDestination } from "../utils/authorization";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger } from "./types";

async function buildJupiterSwapTransaction(
  intent: ValidatedIntent,
  config: AppConfig,
  logger: Logger,
): Promise<{ transaction: VersionedTransaction; agentPublicKey: string }> {
  if (!intent.userDestination) {
    throw new Error(`[solSwap] Missing userDestination for intent ${intent.intentId}`);
  }

  const agentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination,
  );

  const inputMint = extractSolanaMintAddress(intent.intermediateAsset || intent.sourceAsset);
  const outputMint = extractSolanaMintAddress(intent.finalAsset);

  const rawAmount = intent.intermediateAmount || intent.destinationAmount || intent.sourceAmount;

  // Only reserve lamports for ATA rent when the input token is native SOL.
  // For SPL tokens the units are token-specific (e.g. 6-decimal USDC),
  // so subtracting lamport amounts would deduct the wrong value.
  const SOL_NATIVE = "So11111111111111111111111111111111111111112";
  const isNativeSolInput = inputMint === SOL_NATIVE;

  let swapAmount: string;
  if (isNativeSolInput) {
    const ATA_RENT_LAMPORTS = BigInt(2_100_000);
    const rawAmountBigInt = BigInt(rawAmount);
    if (rawAmountBigInt <= ATA_RENT_LAMPORTS) {
      throw new Error(
        `Insufficient SOL amount (${rawAmount} lamports) to cover ATA rent reserve of ${ATA_RENT_LAMPORTS} lamports`,
      );
    }
    swapAmount = (rawAmountBigInt - ATA_RENT_LAMPORTS).toString();
  } else {
    swapAmount = rawAmount;
  }

  logger.debug(`Amount adjustment for ATA rent`, {
    rawAmount,
    swapAmount,
    isNativeSolInput,
  });

  const amount = swapAmount;

  const userWallet = new PublicKey(intent.userDestination);
  const outputMintPubkey = new PublicKey(outputMint);

  // Detect whether the output mint is Token-2022 or legacy SPL Token
  const connection = getSolanaConnection();
  const mintAccountInfo = await connection.getAccountInfo(outputMintPubkey);
  const tokenProgramId = mintAccountInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const userAta = getAssociatedTokenAddressSync(
    outputMintPubkey,
    userWallet,
    false,
    tokenProgramId,
  );

  logger.debug(`Jupiter swap request`, {
    inputMint,
    outputMint,
    amount,
    agentPublicKey: agentPublicKey.toBase58(),
    userDestination: intent.userDestination,
    userAta: userAta.toBase58(),
    tokenProgram: tokenProgramId.toBase58(),
    intentId: intent.intentId,
  });

  const clusterParam = config.jupiterCluster ? `&cluster=${config.jupiterCluster}` : "";
  const quoteUrl = `${config.jupiterBaseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${intent.slippageBps}${clusterParam}`;

  const quoteRes = await fetchWithRetry(
    quoteUrl,
    undefined,
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );
  if (!quoteRes.ok) {
    const body = await quoteRes.text().catch(() => "");
    throw new Error(`Jupiter quote failed: ${quoteRes.status} ${quoteRes.statusText}${body ? ` - ${body}` : ""}`);
  }
  const quote = await quoteRes.json();

  const swapInstructionsRes = await fetchWithRetry(
    `${config.jupiterBaseUrl}/swap-instructions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: agentPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
        destinationTokenAccount: userAta.toBase58(),
        dynamicComputeUnitLimit: true,
        computeUnitPriceMicroLamports: "auto",
      }),
    },
    config.jupiterMaxAttempts,
    config.jupiterRetryBackoffMs,
  );

  if (!swapInstructionsRes.ok) {
    const body = await swapInstructionsRes.text().catch(() => "");
    throw new Error(`Jupiter swap-instructions failed: ${swapInstructionsRes.status} ${body}`);
  }

  const swapInstructions = await swapInstructionsRes.json();

  const instructions: TransactionInstruction[] = [];

  if (swapInstructions.computeBudgetInstructions) {
    for (const ix of swapInstructions.computeBudgetInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
  }

  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    agentPublicKey,
    userAta,
    userWallet,
    outputMintPubkey,
    tokenProgramId,
  );
  instructions.push(createAtaIx);

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

  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    connection,
    swapInstructions.addressLookupTableAddresses || [],
  );

  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: agentPublicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts);

  const transaction = new VersionedTransaction(messageV0);

  return { transaction, agentPublicKey: agentPublicKey.toBase58() };
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

/**
 * Default Solana swap flow using Jupiter DEX aggregator.
 * This is the fallback flow when no specific action is matched.
 */
const solSwapFlow: FlowDefinition<Record<string, unknown>> = {
  action: "sol-swap",
  name: "Solana Swap",
  description: "Swap tokens on Solana using Jupiter DEX aggregator",

  supportedChains: {
    source: ["near", "ethereum", "base", "arbitrum", "solana"],
    destination: ["solana"],
  },

  requiredMetadataFields: [],
  optionalMetadataFields: [],

  isMatch: (intent): intent is ValidatedIntent & { metadata: Record<string, unknown> } => {
    // This is the default flow - matches when destination is Solana and no specific action
    const action = intent.metadata?.action;
    return (
      intent.destinationChain === "solana" &&
      (!action || action === "sol-swap" || action === "swap")
    );
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "Solana swap");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;

    if (config.dryRunSwaps) {
      return { txId: `dry-run-${intent.intentId}` };
    }

    const { transaction } = await buildJupiterSwapTransaction(intent, config, logger);

    const txId = await signAndBroadcastSingleSigner(transaction, intent.userDestination!);

    logger.info(`Solana swap confirmed: ${txId}`);

    return { txId };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { solSwapFlow };

// Legacy export for backwards compatibility
import { config as globalConfig } from "../config";
import { createFlowContext } from "./context";

export async function executeSolanaSwapFlow(
  intent: ValidatedIntent,
): Promise<FlowResult> {
  const ctx = createFlowContext({ intentId: intent.intentId, config: globalConfig });
  if (solSwapFlow.validateAuthorization) {
    // `as any` justified: legacy wrapper, caller must provide correct metadata shape
    await solSwapFlow.validateAuthorization(intent as any, ctx);
  }
  // `as any` justified: legacy wrapper, caller must provide correct metadata shape
  return solSwapFlow.execute(intent as any, ctx);
}
