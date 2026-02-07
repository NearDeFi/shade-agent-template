import {
  createSolanaRpc,
  address,
  pipe,
  createTransactionMessage,
  appendTransactionMessageInstructions,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  compileTransaction,
  Address,
  IInstruction,
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
} from "../utils/solana";
import {
  signWithNearChainSignatures,
  createDummySigner,
} from "../utils/chainSignature";
import { logSolanaIntentsInfo } from "./context";
import { requireUserDestination } from "../utils/authorization";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger } from "./types";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CompiledTransaction {
  messageBytes: Uint8Array;
  signatures: Record<Address, Uint8Array>;
}

interface BuildTxResult {
  compiledTx: CompiledTransaction;
  serializedMessage: Uint8Array;
  feePayerAddress: Address;
  userAgentAddress: Address;
}

interface DerivedAddresses {
  feePayerAddress: Address;
  feePayerSigner: ReturnType<typeof createDummySigner>;
  userAgentAddress: Address;
  userAgentSigner: ReturnType<typeof createDummySigner>;
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

function createKaminoRpc(config: AppConfig) {
  return createSolanaRpc(config.solRpcUrl);
}

/**
 * Send a signed transaction to the Solana network.
 * Handles serialization in the Solana wire format.
 */
async function sendSignedTransaction(
  rpc: ReturnType<typeof createSolanaRpc>,
  signedTx: CompiledTransaction,
): Promise<string> {
  // Serialize to wire format: [num_signatures (1 byte)] + [signatures (64 bytes each)] + [message]
  const signatureAddresses = Object.keys(signedTx.signatures) as Address[];
  const numSignatures = signatureAddresses.length;
  const totalSignatureBytes = numSignatures * 64;
  const serialized = new Uint8Array(1 + totalSignatureBytes + signedTx.messageBytes.length);

  serialized[0] = numSignatures;
  let offset = 1;
  for (const addr of signatureAddresses) {
    serialized.set(signedTx.signatures[addr], offset);
    offset += 64;
  }
  serialized.set(signedTx.messageBytes, offset);

  // Send via RPC
  const base64Tx = Buffer.from(serialized).toString("base64");
  const signature = await rpc.sendTransaction(base64Tx as any, {
    encoding: "base64",
    skipPreflight: false,
    preflightCommitment: "confirmed",
  }).send();

  // Poll for confirmation with retries (getSignatureStatuses is non-blocking)
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { value: statuses } = await rpc.getSignatureStatuses([signature]).send();
    const status = statuses[0];
    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      // Transaction confirmed successfully
      return signature;
    }
    // Not yet processed, wait before retrying
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(`Transaction confirmation timed out after ${maxAttempts}s for ${signature}`);
}

/**
 * Derive fee payer and user agent addresses with their dummy signers.
 * Fee payer is the base agent (pays for gas), user agent holds tokens.
 */
async function deriveDepositAddresses(
  userDestination: string,
): Promise<DerivedAddresses> {
  const feePayerPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);
  const feePayerAddress = address(feePayerPublicKey.toBase58());

  const userAgentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    userDestination,
  );
  const userAgentAddress = address(userAgentPublicKey.toBase58());

  return {
    feePayerAddress,
    feePayerSigner: createDummySigner(feePayerAddress),
    userAgentAddress,
    userAgentSigner: createDummySigner(userAgentAddress),
  };
}

/**
 * Load Kamino market and get the reserve for a specific mint.
 */
async function loadMarketAndReserve(
  rpc: ReturnType<typeof createKaminoRpc>,
  marketAddress: string,
  mintAddress: string,
) {
  const market = await KaminoMarket.load(
    rpc,
    address(marketAddress),
    1000,
    PROGRAM_ID,
  );
  if (!market) {
    throw new Error(`Failed to load Kamino market: ${marketAddress}`);
  }

  const reserve = market.getReserveByMint(address(mintAddress));
  if (!reserve) {
    throw new Error(`Reserve not found for mint: ${mintAddress}`);
  }

  return { market, reserve };
}

/**
 * Minimum SOL needed for rent (user metadata, obligation, farms account, buffer).
 */
const MIN_RENT_LAMPORTS = 45_000_000n;

/**
 * Check if user agent needs rent funding and return the transfer instruction if so.
 */
async function maybeCreateRentFundingInstruction(
  rpc: ReturnType<typeof createKaminoRpc>,
  feePayerSigner: ReturnType<typeof createDummySigner>,
  userAgentAddress: Address,
  logger: Logger,
): Promise<IInstruction | null> {
  const { value: userAgentBalance } = await rpc.getBalance(userAgentAddress).send();

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
      destination: userAgentAddress,
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
): Promise<BuildTxResult> {
  const rpc = createKaminoRpc(config);
  const meta = intent.metadata;

  // Derive addresses and create signers
  const { feePayerAddress, feePayerSigner, userAgentAddress, userAgentSigner } =
    await deriveDepositAddresses(intent.userDestination!);

  logger.debug(`Build TX address info`, {
    feePayerAddress,
    userAgentAddress,
    marketAddress: meta.marketAddress,
    mintAddress: meta.mintAddress,
  });

  // Load market and reserve
  const { market, reserve } = await loadMarketAndReserve(
    rpc,
    meta.marketAddress,
    meta.mintAddress,
  );

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

  // Fetch blockhash for transaction lifetime
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  // Build transaction message using @solana/kit pipe pattern
  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  );

  // Compile the transaction (without signing - we'll sign externally)
  const rawCompiledTx = compileTransaction(txMessage);

  // Convert to our simplified type (avoiding @solana/kit nominal types)
  // Filter out null signatures and convert to Uint8Array
  const compiledTx: CompiledTransaction = {
    messageBytes: new Uint8Array(rawCompiledTx.messageBytes),
    signatures: Object.fromEntries(
      Object.entries(rawCompiledTx.signatures)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, new Uint8Array(v!)])
    ) as Record<Address, Uint8Array>,
  };

  // The message bytes are what we need to sign
  const serializedMessage = compiledTx.messageBytes;

  return {
    compiledTx,
    serializedMessage,
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
    // For deposits, authorization is implicit via the deposit transaction
    // The user proves ownership by sending funds from their wallet
    requireUserDestination(intent, ctx, "Kamino deposit");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;
    const meta = intent.metadata;

    // Log all addresses involved in this flow
    logSolanaIntentsInfo(logger, intent.userDestination!, intent.agentDestination, intent.intentsDepositAddress);

    if (config.dryRunSwaps) {
      logger.info("DRY RUN MODE ENABLED - will build tx but not submit");
    }

    // Get the agent's Solana address with userDestination in path for custody isolation
    const agentPublicKey = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      intent.userDestination,
    );
    const agentSolanaAddress = agentPublicKey.toBase58();

    logger.info(`Derived Solana address (user agent): ${agentSolanaAddress}`);

    // Use intermediateAmount if available (set by quote route after intents swap)
    // Otherwise fall back to sourceAmount for direct deposits
    const depositAmount = intent.intermediateAmount || intent.sourceAmount;

    logger.info(`Executing Kamino deposit for amount: ${depositAmount}`);
    logger.info(`Building Kamino deposit transaction for amount: ${depositAmount}`);

    const { compiledTx, serializedMessage, feePayerAddress, userAgentAddress } =
      await buildKaminoDepositTransaction(intent, depositAmount, config, logger);

    // In dry run mode, skip signing and sending the transaction
    if (config.dryRunSwaps) {
      logger.info("=== DRY RUN MODE - SKIPPING TRANSACTION ===");
      logger.info(`Would sign with fee payer: ${feePayerAddress}`);
      logger.info(`Would sign with user agent: ${userAgentAddress}`);
      logger.info(`Transaction message bytes: ${serializedMessage.length} bytes`);
      logger.info("Dry run complete - no transaction submitted");

      return {
        txId: `dry-run-kamino-${intent.intentId}`,
        intentsDepositAddress: intent.intentsDepositAddress,
        swappedAmount: depositAmount,
      };
    }

    // Transaction requires two signatures:
    // 1. Base agent (fee payer) - pays for gas
    // 2. User-specific derived account (token owner) - holds USDC/tokens

    // Sign with base agent (fee payer)
    const feePayerSignature = await signWithNearChainSignatures(
      serializedMessage,
      undefined, // base agent path
    );

    // Sign with user-specific derived account (token owner)
    const userAgentSignature = await signWithNearChainSignatures(
      serializedMessage,
      intent.userDestination,
    );

    // Add signatures to the compiled transaction
    const signedTx = {
      ...compiledTx,
      signatures: {
        ...compiledTx.signatures,
        [feePayerAddress]: feePayerSignature,
        [userAgentAddress]: userAgentSignature,
      },
    };

    // Send the transaction using @solana/kit
    const rpc = createKaminoRpc(config);
    const txId = await sendSignedTransaction(rpc, signedTx);

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

// Legacy exports for backwards compatibility during migration
export const isKaminoDepositIntent = kaminoDepositFlow.isMatch;

// Legacy execute function wrapper
import { config as globalConfig } from "../config";
import { createFlowContext } from "./context";

export async function executeKaminoDepositFlow(
  intent: ValidatedIntent,
): Promise<FlowResult> {
  if (!kaminoDepositFlow.isMatch(intent)) {
    throw new Error("Intent does not match Kamino deposit flow");
  }
  const ctx = createFlowContext({ intentId: intent.intentId, config: globalConfig });
  if (kaminoDepositFlow.validateAuthorization) {
    await kaminoDepositFlow.validateAuthorization(intent, ctx);
  }
  return kaminoDepositFlow.execute(intent, ctx);
}
