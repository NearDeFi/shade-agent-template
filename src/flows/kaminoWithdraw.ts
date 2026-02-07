import {
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import { createSolanaRpc, address, Address } from "@solana/kit";
import {
  KaminoAction,
  KaminoMarket,
  PROGRAM_ID,
  VanillaObligation,
} from "@kamino-finance/klend-sdk";
import BN from "bn.js";
import { KaminoWithdrawMetadata, ValidatedIntent } from "../queue/types";
import {
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  getSolanaConnection,
  signAndBroadcastDualSigner,
} from "../utils/solana";
import { createDummySigner } from "../utils/chainSignature";
import { validateSolanaWithdrawAuthorization } from "../utils/authorization";
import { SOL_NATIVE_MINT } from "../constants";
import { getDefuseAssetId, getSolDefuseAssetId } from "../utils/tokenMappings";
import { getIntentsQuote, createBridgeBackQuoteRequest } from "../utils/intents";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger } from "./types";

// ─── @solana/kit Instruction Types ──────────────────────────────────────────────

/**
 * Account role in @solana/kit instructions
 * 0 = readonly, 1 = writable, 2 = signer readonly, 3 = signer writable
 */
type AccountRole = 0 | 1 | 2 | 3;

interface KitAccountMeta {
  address: Address;
  role: AccountRole;
}

interface KitInstruction {
  programAddress: Address;
  accounts: readonly KitAccountMeta[];
  data: Uint8Array;
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

function createKaminoRpc(config: AppConfig) {
  return createSolanaRpc(config.solRpcUrl);
}

async function buildKaminoWithdrawTransaction(
  intent: ValidatedIntent & { metadata: KaminoWithdrawMetadata },
  config: AppConfig,
  logger: Logger,
): Promise<{ transaction: VersionedTransaction; serializedMessage: Uint8Array }> {
  const rpc = createKaminoRpc(config);
  const meta = intent.metadata;

  // Base agent pays for transaction fees (has SOL)
  const feePayerPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);

  // User-specific derived account holds kTokens for custody isolation
  const userAgentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination,
  );
  const ownerAddress = address(userAgentPublicKey.toBase58());

  // Create a dummy signer - we only need its address, not actual signing capability
  // The actual signing is done via NEAR chain signatures
  const dummySigner = createDummySigner(ownerAddress);

  const market = await KaminoMarket.load(
    rpc,
    address(meta.marketAddress),
    1000, // recentSlotDurationMs
    PROGRAM_ID,
  );
  if (!market) {
    throw new Error(`Failed to load Kamino market: ${meta.marketAddress}`);
  }

  const reserve = market.getReserveByMint(address(meta.mintAddress));
  if (!reserve) {
    throw new Error(`Reserve not found for mint: ${meta.mintAddress}`);
  }

  const amount = new BN(intent.sourceAmount);

  const withdrawAction = await KaminoAction.buildWithdrawTxns(
    market,
    amount,
    reserve.getLiquidityMint(),
    dummySigner,
    new VanillaObligation(PROGRAM_ID),
    false,
    undefined,
    300_000,
    true,
  );

  logger.debug(`Withdraw action instruction counts`, {
    computeBudgetIxs: withdrawAction.computeBudgetIxs?.length ?? 0,
    setupIxs: withdrawAction.setupIxs?.length ?? 0,
    lendingIxs: withdrawAction.lendingIxs?.length ?? 0,
    cleanupIxs: withdrawAction.cleanupIxs?.length ?? 0,
  });

  const instructions = [
    ...(withdrawAction.computeBudgetIxs || []),
    ...(withdrawAction.setupIxs || []),
    ...(withdrawAction.lendingIxs || []),
    ...(withdrawAction.cleanupIxs || []),
  ].filter((ix) => ix != null);

  logger.debug(`Total instructions after filtering: ${instructions.length}`);

  // For broadcasting via @solana/web3.js, we need to convert the transaction
  const connection = getSolanaConnection();
  const { blockhash } = await connection.getLatestBlockhash();

  // Convert kit instructions to web3.js instructions
  const web3Instructions = instructions.map((ix) => {
    const kitIx = ix as unknown as KitInstruction;
    return {
      programId: new PublicKey(kitIx.programAddress),
      keys: (kitIx.accounts || []).map((acc) => ({
        pubkey: new PublicKey(acc.address),
        isSigner: acc.role === 2 || acc.role === 3,
        isWritable: acc.role === 1 || acc.role === 3,
      })),
      data: Buffer.from(kitIx.data),
    };
  });

  const messageV0 = new TransactionMessage({
    payerKey: feePayerPublicKey,
    recentBlockhash: blockhash,
    instructions: web3Instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);

  return { transaction, serializedMessage: transaction.message.serialize() };
}

interface BridgeBackResult {
  txId: string;
  depositAddress: string;
}

async function executeBridgeBack(
  intent: ValidatedIntent & { metadata: KaminoWithdrawMetadata },
  meta: KaminoWithdrawMetadata,
  config: AppConfig,
  logger: Logger,
): Promise<BridgeBackResult> {
  if (!meta.bridgeBack) {
    throw new Error("bridgeBack configuration missing");
  }

  const mintAddress = meta.mintAddress;

  // Query the actual on-chain token balance instead of using intent.sourceAmount,
  // since the actual withdrawn amount may differ due to rounding, interest, or fees.
  const userAgentPublicKey = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination,
  );
  const connection = getSolanaConnection();
  const mintPubkey = new PublicKey(mintAddress);
  let withdrawnAmount: string;

  if (mintAddress === SOL_NATIVE_MINT) {
    const lamports = await connection.getBalance(userAgentPublicKey);
    withdrawnAmount = lamports.toString();
  } else {
    const ata = await getAssociatedTokenAddress(mintPubkey, userAgentPublicKey);
    const account = await getAccount(connection, ata);
    withdrawnAmount = account.amount.toString();
  }

  if (withdrawnAmount === "0") {
    throw new Error("No tokens available to bridge back after withdrawal");
  }

  logger.info(`Starting bridge back to ${meta.bridgeBack.destinationChain}`, {
    destinationAddress: meta.bridgeBack.destinationAddress,
    destinationAsset: meta.bridgeBack.destinationAsset,
    amount: withdrawnAmount,
    requestedAmount: intent.sourceAmount,
    mintAddress,
  });

  // Get deposit address from Defuse Intents
  const originAsset =
    mintAddress === SOL_NATIVE_MINT
      ? getSolDefuseAssetId()
      : getDefuseAssetId("solana", mintAddress) || `nep141:${mintAddress}.omft.near`;

  const quoteRequest = createBridgeBackQuoteRequest(
    meta.bridgeBack,
    originAsset,
    withdrawnAmount,
    intent.refundAddress || intent.userDestination,
  );

  const { depositAddress } = await getIntentsQuote(quoteRequest, config);

  const feePayerPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);
  const { blockhash } = await connection.getLatestBlockhash();

  let transferIx;
  const depositPubkey = new PublicKey(depositAddress);

  if (mintAddress === SOL_NATIVE_MINT) {
    transferIx = SystemProgram.transfer({
      fromPubkey: userAgentPublicKey,
      toPubkey: depositPubkey,
      lamports: BigInt(withdrawnAmount),
    });
  } else {
    const mintPubkey = new PublicKey(mintAddress);

    const sourceAta = await getAssociatedTokenAddress(
      mintPubkey,
      userAgentPublicKey,
    );

    const destinationAta = await getAssociatedTokenAddress(
      mintPubkey,
      depositPubkey,
      true,
    );

    const destinationAtaInfo = await connection.getAccountInfo(destinationAta);

    const instructions = [];

    if (!destinationAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          feePayerPublicKey,
          destinationAta,
          depositPubkey,
          mintPubkey,
        ),
      );
    }

    instructions.push(
      createTransferInstruction(
        sourceAta,
        destinationAta,
        userAgentPublicKey,
        BigInt(withdrawnAmount),
      ),
    );

    const messageV0 = new TransactionMessage({
      payerKey: feePayerPublicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    const serializedMessage = transaction.message.serialize();

    const txId = await signAndBroadcastDualSigner(transaction, serializedMessage, intent.userDestination);

    logger.info(`Bridge transfer tx confirmed: ${txId}`);

    return { txId, depositAddress };
  }

  const messageV0 = new TransactionMessage({
    payerKey: feePayerPublicKey,
    recentBlockhash: blockhash,
    instructions: [transferIx],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  const serializedMessage = transaction.message.serialize();

  const txId = await signAndBroadcastDualSigner(transaction, serializedMessage, intent.userDestination);

  logger.info(`Bridge transfer tx confirmed: ${txId}`);

  return { txId, depositAddress };
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

const kaminoWithdrawFlow: FlowDefinition<KaminoWithdrawMetadata> = {
  action: "kamino-withdraw",
  name: "Kamino Withdraw",
  description: "Withdraw tokens from Kamino lending market on Solana",

  supportedChains: {
    source: ["solana"],
    destination: ["solana", "near", "ethereum", "base", "arbitrum"],
  },

  requiredMetadataFields: ["action", "marketAddress", "mintAddress"],
  optionalMetadataFields: ["bridgeBack"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: KaminoWithdrawMetadata } => {
    const meta = intent.metadata as KaminoWithdrawMetadata | undefined;
    return meta?.action === "kamino-withdraw" && !!meta.marketAddress && !!meta.mintAddress;
  },

  validateAuthorization: async (intent, ctx) => {
    validateSolanaWithdrawAuthorization(intent, ctx, "Kamino withdraw");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;
    const meta = intent.metadata;

    if (config.dryRunSwaps) {
      const result: FlowResult = { txId: `dry-run-kamino-withdraw-${intent.intentId}` };
      if (meta.bridgeBack) {
        result.bridgeTxId = `dry-run-bridge-${intent.intentId}`;
        result.intentsDepositAddress = "dry-run-deposit-address";
      }
      return result;
    }

    // Step 1: Execute Kamino withdrawal
    const { transaction, serializedMessage } = await buildKaminoWithdrawTransaction(intent, config, logger);

    const txId = await signAndBroadcastDualSigner(transaction, serializedMessage, intent.userDestination);

    logger.info(`Withdrawal tx confirmed: ${txId}`);

    // Step 2: If bridgeBack is configured, send withdrawn tokens to intents
    if (meta.bridgeBack) {
      const bridgeResult = await executeBridgeBack(intent, meta, config, logger);
      return {
        txId,
        bridgeTxId: bridgeResult.txId,
        intentsDepositAddress: bridgeResult.depositAddress,
      };
    }

    return { txId };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { kaminoWithdrawFlow };

// Legacy exports for backwards compatibility during migration
export const isKaminoWithdrawIntent = kaminoWithdrawFlow.isMatch;

import { config as globalConfig } from "../config";
import { createFlowContext } from "./context";

export async function executeKaminoWithdrawFlow(
  intent: ValidatedIntent,
): Promise<FlowResult> {
  if (!kaminoWithdrawFlow.isMatch(intent)) {
    throw new Error("Intent does not match Kamino withdraw flow");
  }
  const ctx = createFlowContext({ intentId: intent.intentId, config: globalConfig });
  if (kaminoWithdrawFlow.validateAuthorization) {
    await kaminoWithdrawFlow.validateAuthorization(intent, ctx);
  }
  return kaminoWithdrawFlow.execute(intent, ctx);
}
