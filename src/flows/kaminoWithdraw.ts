import { address, type Address, type IInstruction } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstruction,
  getTransferInstruction,
  fetchToken,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
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
  getSolanaRpc,
  signAndBroadcastDualSigner,
  buildAndCompileTransaction,
  createKaminoRpc,
  type CompiledTransaction,
  type SolanaRpc,
} from "../utils/solana";
import { createDummySigner } from "../utils/chainSignature";
import { validateSolanaWithdrawAuthorization } from "../utils/authorization";
import { SOL_NATIVE_MINT } from "../constants";
import { getDefuseAssetId, getSolDefuseAssetId } from "../utils/tokenMappings";
import { getIntentsQuote, createBridgeBackQuoteRequest } from "../utils/intents";
import { dryRunResult } from "./context";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger, BridgeBackResult } from "./types";

// ─── Helper Functions ──────────────────────────────────────────────────────────

async function buildKaminoWithdrawTransaction(
  intent: ValidatedIntent & { metadata: KaminoWithdrawMetadata },
  config: AppConfig,
  logger: Logger,
): Promise<{ compiledTx: CompiledTransaction }> {
  const rpc = createKaminoRpc(config.solRpcUrl);
  const meta = intent.metadata;

  // Base agent pays for transaction fees (has SOL)
  const feePayerAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);

  // User-specific derived account holds kTokens for custody isolation
  const userAgentAddress = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination,
  );

  const dummySigner = createDummySigner(userAgentAddress);

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
  ].filter((ix) => ix != null) as IInstruction[];

  logger.debug(`Total instructions after filtering: ${instructions.length}`);

  const compiledTx = await buildAndCompileTransaction({
    instructions,
    feePayer: feePayerAddress,
    rpc,
  });

  return { compiledTx };
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

  // Query the actual on-chain token balance
  const userAgentAddress = await deriveAgentPublicKey(
    SOLANA_DEFAULT_PATH,
    intent.userDestination,
  );
  const rpc = getSolanaRpc();
  let withdrawnAmount: string;

  if (mintAddress === SOL_NATIVE_MINT) {
    const { value: lamports } = await rpc.getBalance(userAgentAddress).send();
    withdrawnAmount = lamports.toString();
  } else {
    const mintAddr = address(mintAddress);
    const [ata] = await findAssociatedTokenPda({
      mint: mintAddr,
      owner: userAgentAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const account = await fetchToken(rpc, ata);
    withdrawnAmount = account.data.amount.toString();
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

  const feePayerAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH);
  const depositAddr = address(depositAddress);

  const instructions: IInstruction[] = [];

  if (mintAddress === SOL_NATIVE_MINT) {
    instructions.push(getTransferSolInstruction({
      source: createDummySigner(userAgentAddress),
      destination: depositAddr,
      amount: BigInt(withdrawnAmount),
    }) as IInstruction);
  } else {
    const mintAddr = address(mintAddress);

    const [sourceAta] = await findAssociatedTokenPda({
      mint: mintAddr,
      owner: userAgentAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const [destinationAta] = await findAssociatedTokenPda({
      mint: mintAddr,
      owner: depositAddr,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const destinationAtaInfo = await rpc.getAccountInfo(destinationAta, { encoding: "base64" }).send();

    if (!destinationAtaInfo.value) {
      instructions.push(getCreateAssociatedTokenInstruction({
        payer: createDummySigner(address(feePayerAddress)),
        ata: destinationAta,
        owner: depositAddr,
        mint: mintAddr,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }) as IInstruction);
    }

    instructions.push(getTransferInstruction({
      source: sourceAta,
      destination: destinationAta,
      authority: createDummySigner(userAgentAddress),
      amount: BigInt(withdrawnAmount),
    }) as IInstruction);
  }

  const compiledTx = await buildAndCompileTransaction({
    instructions,
    feePayer: feePayerAddress,
    rpc,
  });

  const txId = await signAndBroadcastDualSigner(compiledTx, intent.userDestination);

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

    const dry = dryRunResult("kamino-withdraw", intent.intentId, config, { bridgeBack: !!meta.bridgeBack });
    if (dry) return dry;

    // Step 1: Execute Kamino withdrawal
    const { compiledTx } = await buildKaminoWithdrawTransaction(intent, config, logger);

    const txId = await signAndBroadcastDualSigner(compiledTx, intent.userDestination);

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
