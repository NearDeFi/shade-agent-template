import { address, type Address, type IInstruction } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { extractSolanaMintAddress } from "../constants";
import { ValidatedIntent, SolSwapMetadata } from "../queue/types";
import {
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  getSolanaRpc,
  signAndBroadcastSingleSigner,
  deserializeInstruction,
  getAddressLookupTableAccounts,
  buildAndCompileTransaction,
  type CompiledTransaction,
} from "../utils/solana";
import { createDummySigner } from "../utils/chainSignature";
import { fetchWithRetry } from "../utils/http";
import { requireUserDestination } from "../utils/authorization";
import { dryRunResult } from "./context";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger } from "./types";

async function buildJupiterSwapTransaction(
  intent: ValidatedIntent,
  config: AppConfig,
  logger: Logger,
): Promise<{ compiledTx: CompiledTransaction; agentPublicKey: string }> {
  if (!intent.userDestination) {
    throw new Error(`[solSwap] Missing userDestination for intent ${intent.intentId}`);
  }

  const agentAddress = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination,
  );

  const inputMint = extractSolanaMintAddress(intent.intermediateAsset || intent.sourceAsset);
  const outputMint = extractSolanaMintAddress(intent.finalAsset);

  const rawAmount = intent.intermediateAmount || intent.destinationAmount || intent.sourceAmount;

  // Only reserve lamports for ATA rent when the input token is native SOL.
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

  const userWallet = address(intent.userDestination);
  const outputMintAddr = address(outputMint);

  // Detect whether the output mint is Token-2022 or legacy SPL Token
  const rpc = getSolanaRpc();
  const mintAccountInfo = await rpc.getAccountInfo(outputMintAddr, { encoding: "base64" }).send();
  const tokenProgramAddress = mintAccountInfo.value?.owner === TOKEN_2022_PROGRAM_ADDRESS
    ? TOKEN_2022_PROGRAM_ADDRESS
    : TOKEN_PROGRAM_ADDRESS;

  const [userAta] = await findAssociatedTokenPda({
    mint: outputMintAddr,
    owner: userWallet,
    tokenProgram: tokenProgramAddress,
  });

  logger.debug(`Jupiter swap request`, {
    inputMint,
    outputMint,
    amount,
    agentPublicKey: agentAddress,
    userDestination: intent.userDestination,
    userAta,
    tokenProgram: tokenProgramAddress,
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
        userPublicKey: agentAddress,
        wrapAndUnwrapSol: true,
        destinationTokenAccount: userAta,
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

  const instructions: IInstruction[] = [];

  if (swapInstructions.computeBudgetInstructions) {
    for (const ix of swapInstructions.computeBudgetInstructions) {
      instructions.push(deserializeInstruction(ix));
    }
  }

  const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
    payer: createDummySigner(address(agentAddress)),
    ata: userAta,
    owner: userWallet,
    mint: outputMintAddr,
    tokenProgram: tokenProgramAddress,
  });
  instructions.push(createAtaIx as IInstruction);

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
    rpc,
    swapInstructions.addressLookupTableAddresses || [],
  );

  const compiledTx = await buildAndCompileTransaction({
    instructions,
    feePayer: agentAddress,
    rpc,
    addressLookupTables: addressLookupTableAccounts,
  });

  return { compiledTx, agentPublicKey: agentAddress };
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

/**
 * Default Solana swap flow using Jupiter DEX aggregator.
 * This is the fallback flow when no specific action is matched.
 */
const solSwapFlow: FlowDefinition<SolSwapMetadata> = {
  action: "sol-swap",
  name: "Solana Swap",
  description: "Swap tokens on Solana using Jupiter DEX aggregator",

  supportedChains: {
    source: ["near", "ethereum", "base", "arbitrum", "solana"],
    destination: ["solana"],
  },

  requiredMetadataFields: [],
  optionalMetadataFields: [],

  isMatch: (intent): intent is ValidatedIntent & { metadata: SolSwapMetadata } => {
    // This is the default flow - matches when destination is Solana and no specific action
    const action = intent.metadata?.action;
    return (
      intent.destinationChain === "solana" &&
      (!action || action === "sol-swap")
    );
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "Solana swap");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;

    const dry = dryRunResult("sol-swap", intent.intentId, config);
    if (dry) return dry;

    const { compiledTx } = await buildJupiterSwapTransaction(intent, config, logger);

    const txId = await signAndBroadcastSingleSigner(compiledTx, intent.userDestination!);

    logger.info(`Solana swap confirmed: ${txId}`);

    return { txId };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { solSwapFlow };
