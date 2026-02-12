import { address, type Address, type IInstruction } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { SolBridgeOutMetadata, ValidatedIntent } from "../queue/types";
import {
  deriveAgentPublicKey,
  getSolanaRpc,
  signAndBroadcastDualSigner,
  buildAndCompileTransaction,
  SOLANA_DEFAULT_PATH,
  SOL_NATIVE_MINT,
  type SolanaRpc,
} from "../utils/solana";
import { createDummySigner } from "../utils/chainSignature";
import { getSolDefuseAssetId } from "../utils/tokenMappings";
import { getIntentsQuote, createBridgeBackQuoteRequest } from "../utils/intents";
import { dryRunResult } from "./context";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger } from "./types";

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Close the wSOL ATA to unwrap wSOL back to native SOL.
 * The lamports from the closed account go to the destination (the agent account).
 */
async function unwrapWsol(
  userAgentAddress: Address,
  feePayerAddress: Address,
  rpc: SolanaRpc,
  userDestination: string,
  logger: Logger,
  dryRun: boolean,
): Promise<string> {
  const [wsolAta] = await findAssociatedTokenPda({
    mint: SOL_NATIVE_MINT,
    owner: userAgentAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  logger.info(`Closing wSOL ATA to unwrap`, {
    wsolAta,
    userAgent: userAgentAddress,
  });

  if (dryRun) {
    return `dry-run-unwrap-wsol`;
  }

  const closeIx = getCloseAccountInstruction({
    account: wsolAta,
    destination: userAgentAddress,
    owner: createDummySigner(userAgentAddress),
  }, { programAddress: TOKEN_PROGRAM_ADDRESS });

  const compiledTx = await buildAndCompileTransaction({
    instructions: [closeIx as IInstruction],
    feePayer: feePayerAddress,
    rpc,
  });

  const txId = await signAndBroadcastDualSigner(compiledTx, userDestination);

  logger.info(`wSOL unwrap confirmed: ${txId}`);
  return txId;
}

/**
 * Transfer native SOL from the user agent to a Defuse deposit address.
 */
async function transferSolToDefuse(
  userAgentAddress: Address,
  feePayerAddress: Address,
  depositAddress: string,
  lamports: bigint,
  rpc: SolanaRpc,
  userDestination: string,
  logger: Logger,
  dryRun: boolean,
): Promise<string> {
  logger.info(`Transferring SOL to Defuse deposit`, {
    from: userAgentAddress,
    to: depositAddress,
    lamports: lamports.toString(),
  });

  if (dryRun) {
    return `dry-run-sol-transfer`;
  }

  const transferIx = getTransferSolInstruction({
    source: createDummySigner(userAgentAddress),
    destination: address(depositAddress),
    amount: lamports,
  });

  const compiledTx = await buildAndCompileTransaction({
    instructions: [transferIx as IInstruction],
    feePayer: feePayerAddress,
    rpc,
  });

  const txId = await signAndBroadcastDualSigner(compiledTx, userDestination);

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
    const feePayerAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);
    const userAgentAddress = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      intent.userDestination,
    );

    const rpc = getSolanaRpc();

    const dry = dryRunResult("sol-bridge-out", intent.intentId, config, { bridgeBack: true });
    if (dry) return dry;

    // Step 1: Close wSOL ATA to unwrap wSOL → native SOL
    const unwrapTxId = await unwrapWsol(
      userAgentAddress,
      feePayerAddress,
      rpc,
      intent.userDestination,
      logger,
      false,
    );

    // Step 2: Check agent SOL balance to determine how much to bridge
    const { value: balance } = await rpc.getBalance(userAgentAddress).send();
    // Reserve some SOL for future rent/fees (0.005 SOL)
    const RENT_RESERVE = BigInt(5_000_000);
    const bridgeAmount = balance > RENT_RESERVE
      ? balance - RENT_RESERVE
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
      userAgentAddress, // refund to the agent if bridge fails
    );

    const { depositAddress } = await getIntentsQuote(quoteRequest, config);

    // Step 4: Transfer native SOL to Defuse deposit address
    const bridgeTxId = await transferSolToDefuse(
      userAgentAddress,
      feePayerAddress,
      depositAddress,
      bridgeAmount,
      rpc,
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

// ─── Exports ───────────────────────────────────────────────────────────────────

export { solBridgeOutFlow };
