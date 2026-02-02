import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SolBridgeOutMetadata, ValidatedIntent } from "../queue/types";
import {
  deriveAgentPublicKey,
  getSolanaConnection,
  signAndBroadcastDualSigner,
  SOLANA_DEFAULT_PATH,
} from "../utils/solana";
import { getSolDefuseAssetId } from "../utils/tokenMappings";
import { getIntentsQuote, createBridgeBackQuoteRequest } from "../utils/intents";
import { flowRegistry } from "./registry";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger } from "./types";

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Close the wSOL ATA to unwrap wSOL back to native SOL.
 * The lamports from the closed account go to the destination (the agent account).
 */
async function unwrapWsol(
  userAgentPublicKey: PublicKey,
  feePayerPublicKey: PublicKey,
  connection: Connection,
  userDestination: string,
  logger: Logger,
  dryRun: boolean,
): Promise<string> {
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    userAgentPublicKey,
    true,
    TOKEN_PROGRAM_ID,
  );

  logger.info(`Closing wSOL ATA to unwrap`, {
    wsolAta: wsolAta.toBase58(),
    userAgent: userAgentPublicKey.toBase58(),
  });

  if (dryRun) {
    return `dry-run-unwrap-wsol`;
  }

  const closeIx = createCloseAccountInstruction(
    wsolAta,
    userAgentPublicKey, // lamports go to the agent account
    userAgentPublicKey, // owner of the wSOL ATA
    [],
    TOKEN_PROGRAM_ID,
  );

  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: feePayerPublicKey,
    recentBlockhash: blockhash,
    instructions: [closeIx],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  const serializedMessage = transaction.message.serialize();

  const txId = await signAndBroadcastDualSigner(
    transaction,
    serializedMessage,
    userDestination,
  );

  logger.info(`wSOL unwrap confirmed: ${txId}`);
  return txId;
}

/**
 * Transfer native SOL from the user agent to a Defuse deposit address.
 */
async function transferSolToDefuse(
  userAgentPublicKey: PublicKey,
  feePayerPublicKey: PublicKey,
  depositAddress: string,
  lamports: bigint,
  connection: Connection,
  userDestination: string,
  logger: Logger,
  dryRun: boolean,
): Promise<string> {
  logger.info(`Transferring SOL to Defuse deposit`, {
    from: userAgentPublicKey.toBase58(),
    to: depositAddress,
    lamports: lamports.toString(),
  });

  if (dryRun) {
    return `dry-run-sol-transfer`;
  }

  const transferIx = SystemProgram.transfer({
    fromPubkey: userAgentPublicKey,
    toPubkey: new PublicKey(depositAddress),
    lamports,
  });

  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: feePayerPublicKey,
    recentBlockhash: blockhash,
    instructions: [transferIx],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  const serializedMessage = transaction.message.serialize();

  const txId = await signAndBroadcastDualSigner(
    transaction,
    serializedMessage,
    userDestination,
  );

  logger.info(`SOL transfer to Defuse confirmed: ${txId}`);
  return txId;
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

const solBridgeOutFlow: FlowDefinition<SolBridgeOutMetadata> = {
  action: "sol-bridge-out",
  name: "Solana Bridge Out",
  description: "Bridge SOL out from Solana to another chain via Defuse Intents (sell flow)",

  supportedChains: {
    source: ["solana"],
    destination: ["near", "ethereum", "base", "arbitrum", "optimism", "aurora", "polygon", "bnb", "avalanche"],
  },

  requiredMetadataFields: ["action", "userSourceAddress", "userTxHash", "userTxConfirmed", "destinationChain", "destinationAddress", "destinationAsset"],
  optionalMetadataFields: ["slippageTolerance"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: SolBridgeOutMetadata } => {
    const meta = intent.metadata as SolBridgeOutMetadata | undefined;
    return (
      meta?.action === "sol-bridge-out" &&
      !!meta.userTxConfirmed &&
      !!meta.userSourceAddress &&
      !!meta.destinationAddress
    );
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;
    const meta = intent.metadata;

    // Derive agent keys
    const feePayerPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);
    const userAgentPublicKey = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      intent.userDestination,
    );

    const connection = getSolanaConnection();

    if (config.dryRunSwaps) {
      return {
        txId: `dry-run-sol-bridge-out-${intent.intentId}`,
        bridgeTxId: `dry-run-bridge-${intent.intentId}`,
        intentsDepositAddress: "dry-run-deposit-address",
      };
    }

    // Step 1: Close wSOL ATA to unwrap wSOL → native SOL
    const unwrapTxId = await unwrapWsol(
      userAgentPublicKey,
      feePayerPublicKey,
      connection,
      intent.userDestination,
      logger,
      false,
    );

    // Step 2: Check agent SOL balance to determine how much to bridge
    const balance = await connection.getBalance(userAgentPublicKey);
    // Reserve some SOL for future rent/fees (0.005 SOL)
    const RENT_RESERVE = BigInt(5_000_000);
    const bridgeAmount = BigInt(balance) > RENT_RESERVE
      ? BigInt(balance) - RENT_RESERVE
      : BigInt(0);

    if (bridgeAmount <= BigInt(0)) {
      throw new Error(
        `Insufficient SOL balance after unwrap. Balance: ${balance} lamports, reserve: ${RENT_RESERVE.toString()}`
      );
    }

    logger.info(`SOL balance after unwrap`, {
      balance: balance.toString(),
      bridgeAmount: bridgeAmount.toString(),
      reserved: RENT_RESERVE.toString(),
    });

    // Step 3: Get Defuse deposit address for the bridge
    const originAsset = getSolDefuseAssetId();
    const quoteRequest = createBridgeBackQuoteRequest(
      {
        destinationChain: meta.destinationChain,
        destinationAddress: meta.destinationAddress,
        destinationAsset: meta.destinationAsset,
        slippageTolerance: meta.slippageTolerance,
      },
      originAsset,
      bridgeAmount.toString(),
      userAgentPublicKey.toBase58(), // refund to the agent if bridge fails
    );

    const { depositAddress } = await getIntentsQuote(quoteRequest, config);

    // Step 4: Transfer native SOL to Defuse deposit address
    const bridgeTxId = await transferSolToDefuse(
      userAgentPublicKey,
      feePayerPublicKey,
      depositAddress,
      bridgeAmount,
      connection,
      intent.userDestination,
      logger,
      false,
    );

    return {
      txId: unwrapTxId,
      bridgeTxId,
      intentsDepositAddress: depositAddress,
      txIds: [unwrapTxId, bridgeTxId],
    };
  },
};

// ─── Self-Registration ─────────────────────────────────────────────────────────

flowRegistry.register(solBridgeOutFlow);

// ─── Exports ───────────────────────────────────────────────────────────────────

export { solBridgeOutFlow };
