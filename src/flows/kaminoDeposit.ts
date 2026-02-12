import {
  address,
  type Address,
  type IInstruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  KaminoAction,
  KaminoMarket,
  PROGRAM_ID,
  VanillaObligation,
} from "@kamino-finance/klend-sdk";
import BN from "bn.js";
import { KaminoDepositMetadata, ValidatedIntent } from "../queue/types";
import {
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  createKaminoRpc,
  broadcastSolanaTx,
  buildAndCompileTransaction,
  attachMultipleSignaturesToCompiledTx,
  type CompiledTransaction,
  type SolanaRpc,
} from "../utils/solana";
import {
  signWithNearChainSignatures,
  createDummySigner,
} from "../utils/chainSignature";
import { logSolanaIntentsInfo, dryRunResult } from "./context";
import { requireUserDestination } from "../utils/authorization";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger } from "./types";

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Minimum SOL needed for rent (user metadata, obligation, farms account, buffer).
 */
const MIN_RENT_LAMPORTS = 45_000_000n;

/**
 * Check if user agent needs rent funding and return the transfer instruction if so.
 */
async function maybeCreateRentFundingInstruction(
  rpc: SolanaRpc,
  feePayerSigner: ReturnType<typeof createDummySigner>,
  userAgentAddress: string,
  logger: Logger,
): Promise<IInstruction | null> {
  const { value: userAgentBalance } = await rpc.getBalance(address(userAgentAddress)).send();

  if (userAgentBalance < MIN_RENT_LAMPORTS) {
    const amountNeeded = MIN_RENT_LAMPORTS - userAgentBalance;
    logger.debug(`Sponsored funds transfer`, {
      from: feePayerSigner.address,
      to: userAgentAddress,
      currentBalance: userAgentBalance,
      minRequired: MIN_RENT_LAMPORTS,
      amountTransferred: amountNeeded,
    });

    return getTransferSolInstruction({
      source: feePayerSigner,
      destination: address(userAgentAddress),
      amount: amountNeeded,
    });
  }

  logger.debug(`User agent has sufficient SOL: ${userAgentBalance} lamports`);
  return null;
}

async function buildKaminoDepositTransaction(
  intent: ValidatedIntent & { metadata: KaminoDepositMetadata },
  depositAmount: string,
  config: AppConfig,
  logger: Logger,
): Promise<{ compiledTx: CompiledTransaction; feePayerAddress: Address; userAgentAddress: Address }> {
  const rpc = createKaminoRpc(config.solRpcUrl);
  const meta = intent.metadata;

  // Derive addresses and create signers
  const feePayerAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);
  const userAgentAddress = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination!,
  );

  const feePayerSigner = createDummySigner(feePayerAddress);
  const userAgentSigner = createDummySigner(userAgentAddress);

  logger.debug(`Build TX address info`, {
    feePayerAddress,
    userAgentAddress,
    marketAddress: meta.marketAddress,
    mintAddress: meta.mintAddress,
  });

  // Load market and reserve
  const market = await KaminoMarket.load(
    rpc,
    address(meta.marketAddress),
    1000,
    PROGRAM_ID,
  );
  if (!market) {
    throw new Error(`Failed to load Kamino market: ${meta.marketAddress}`);
  }

  const reserve = market.getReserveByMint(address(meta.mintAddress));
  if (!reserve) {
    throw new Error(`Reserve not found for mint: ${meta.mintAddress}`);
  }

  // Build deposit instructions
  const depositAction = await KaminoAction.buildDepositTxns(
    market,
    new BN(depositAmount),
    reserve.getLiquidityMint(),
    userAgentSigner,
    new VanillaObligation(PROGRAM_ID),
    false,
    undefined,
    300_000,
    true,
    false,
    { skipInitialization: false, skipLutCreation: true },
  );

  const kaminoInstructions = [
    ...(depositAction.computeBudgetIxs || []),
    ...(depositAction.setupIxs || []),
    ...(depositAction.lendingIxs || []),
    ...(depositAction.cleanupIxs || []),
  ].filter((ix) => ix != null);

  // Build final instruction list (rent funding + Kamino instructions)
  const instructions: IInstruction[] = [];

  const rentFundingIx = await maybeCreateRentFundingInstruction(
    rpc,
    feePayerSigner,
    userAgentAddress,
    logger,
  );
  if (rentFundingIx) {
    instructions.push(rentFundingIx);
  }

  instructions.push(...kaminoInstructions);

  logger.debug(`Built ${instructions.length} instructions from Kamino SDK`);

  const compiledTx = await buildAndCompileTransaction({
    instructions,
    feePayer: feePayerAddress,
    rpc,
  });

  return {
    compiledTx,
    feePayerAddress,
    userAgentAddress,
  };
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

const kaminoDepositFlow: FlowDefinition<KaminoDepositMetadata> = {
  action: "kamino-deposit",
  name: "Kamino Deposit",
  description: "Deposit tokens into Kamino lending market on Solana",

  supportedChains: {
    source: ["near", "ethereum", "base", "arbitrum", "solana"],
    destination: ["solana"],
  },

  requiredMetadataFields: ["action", "marketAddress", "mintAddress"],
  optionalMetadataFields: ["targetDefuseAssetId", "useIntents", "slippageTolerance"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: KaminoDepositMetadata } => {
    const meta = intent.metadata as KaminoDepositMetadata | undefined;
    return meta?.action === "kamino-deposit" && !!meta.marketAddress && !!meta.mintAddress;
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "Kamino deposit");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;
    const meta = intent.metadata;

    // Log all addresses involved in this flow
    logSolanaIntentsInfo(logger, intent.userDestination!, intent.agentDestination, intent.intentsDepositAddress);

    // Use intermediateAmount if available (set by quote route after intents swap)
    const depositAmount = intent.intermediateAmount || intent.sourceAmount;

    const dry = dryRunResult("kamino-deposit", intent.intentId, config, {
      intentsDepositAddress: intent.intentsDepositAddress,
      swappedAmount: depositAmount,
    });
    if (dry) return dry;

    // Get the agent's Solana address with userDestination in path for custody isolation
    const agentSolanaAddress = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      intent.userDestination,
    );

    logger.info(`Derived Solana address (user agent): ${agentSolanaAddress}`);

    logger.info(`Executing Kamino deposit for amount: ${depositAmount}`);
    logger.info(`Building Kamino deposit transaction for amount: ${depositAmount}`);

    const { compiledTx, feePayerAddress, userAgentAddress } =
      await buildKaminoDepositTransaction(intent, depositAmount, config, logger);

    // Sign with base agent (fee payer)
    const feePayerSignature = await signWithNearChainSignatures(
      compiledTx.messageBytes,
      undefined,
    );

    // Sign with user-specific derived account (token owner)
    const userAgentSignature = await signWithNearChainSignatures(
      compiledTx.messageBytes,
      intent.userDestination,
    );

    // Add signatures to the compiled transaction
    const signedTx = attachMultipleSignaturesToCompiledTx(compiledTx, [
      { address: feePayerAddress, signature: feePayerSignature },
      { address: userAgentAddress, signature: userAgentSignature },
    ]);

    // Send the transaction
    const rpc = createKaminoRpc(config.solRpcUrl);
    const txId = await broadcastSolanaTx(signedTx);

    logger.info(`Kamino deposit confirmed: ${txId}`);

    return {
      txId,
      intentsDepositAddress: intent.intentsDepositAddress,
      swappedAmount: depositAmount,
    };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { kaminoDepositFlow };
