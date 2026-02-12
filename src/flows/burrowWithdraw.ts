import { BurrowWithdrawMetadata, ValidatedIntent } from "../queue/types";
import {
  getAssetsPagedDetailed,
  buildWithdrawTransaction,
} from "../utils/burrow";
import { validateNearWithdrawAuthorization } from "../utils/authorization";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
  executeNearFunctionCall,
  NEAR_DEFAULT_PATH,
  GAS_FOR_FT_TRANSFER_CALL,
  ZERO_DEPOSIT,
  ONE_YOCTO,
  NearAgentAccount,
} from "../utils/near";
import { getDefuseAssetId } from "../utils/tokenMappings";
import { getFtBalance } from "../utils/nearRpc";
import { getIntentsQuote, createBridgeBackQuoteRequest } from "../utils/intents";
import { logNearAddressInfo, dryRunResult } from "./context";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger, BridgeBackResult } from "./types";

// ─── Helper Functions ──────────────────────────────────────────────────────────

async function executeBridgeBack(
  intent: ValidatedIntent & { metadata: BurrowWithdrawMetadata },
  meta: BurrowWithdrawMetadata,
  userAgent: NearAgentAccount,
  config: AppConfig,
  logger: Logger,
): Promise<BridgeBackResult> {
  if (!meta.bridgeBack) {
    throw new Error("bridgeBack configuration missing");
  }

  const tokenId = meta.tokenId;

  // Query the actual on-chain token balance instead of using intent.sourceAmount,
  // since the actual withdrawn amount may differ due to rounding, interest, or fees.
  const withdrawnAmount = await getFtBalance(tokenId, userAgent.accountId);
  if (withdrawnAmount === "0") {
    throw new Error("No tokens available to bridge back after withdrawal");
  }

  logger.info(`Starting bridge back to ${meta.bridgeBack.destinationChain}`, {
    destinationAddress: meta.bridgeBack.destinationAddress,
    destinationAsset: meta.bridgeBack.destinationAsset,
    amount: withdrawnAmount,
    requestedAmount: intent.sourceAmount,
    tokenId,
  });

  // Get deposit address from Defuse Intents
  const originAsset = getDefuseAssetId("near", tokenId) || `nep141:${tokenId}`;
  const quoteRequest = createBridgeBackQuoteRequest(
    meta.bridgeBack,
    originAsset,
    withdrawnAmount,
    intent.refundAddress || intent.userDestination,
  );

  const { depositAddress } = await getIntentsQuote(quoteRequest, config);

  // Execute ft_transfer_call to send tokens to intents deposit address
  const bridgeTxHash = await executeNearFunctionCall({
    from: userAgent,
    receiverId: tokenId,
    methodName: "ft_transfer_call",
    args: {
      receiver_id: depositAddress,
      amount: withdrawnAmount,
      msg: "",
    },
    gas: GAS_FOR_FT_TRANSFER_CALL,
    deposit: ONE_YOCTO,
  });

  logger.info(`Bridge transfer tx confirmed: ${bridgeTxHash}`);

  return { txId: bridgeTxHash, depositAddress };
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

const burrowWithdrawFlow: FlowDefinition<BurrowWithdrawMetadata> = {
  action: "burrow-withdraw",
  name: "Burrow Withdraw",
  description: "Withdraw tokens from Burrow lending protocol on NEAR",

  supportedChains: {
    source: ["near"],
    destination: ["near", "ethereum", "base", "arbitrum", "solana"],
  },

  requiredMetadataFields: ["action", "tokenId"],
  optionalMetadataFields: ["bridgeBack"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: BurrowWithdrawMetadata } => {
    const meta = intent.metadata as BurrowWithdrawMetadata | undefined;
    return meta?.action === "burrow-withdraw" && !!meta.tokenId;
  },

  validateMetadata: (metadata) => {
    // Sanitize tokenId: strip nep141: prefix if present (Defuse asset ID format)
    if (metadata.tokenId.startsWith("nep141:")) {
      metadata.tokenId = metadata.tokenId.slice(7);
    }

    // Validate tokenId looks like a NEAR account (either named account with . or hex implicit account)
    const isNamedAccount = metadata.tokenId.includes(".");
    const isImplicitAccount = /^[0-9a-f]{64}$/i.test(metadata.tokenId);
    if (!isNamedAccount && !isImplicitAccount) {
      throw new Error("Burrow withdraw tokenId must be a valid NEAR contract address");
    }
  },

  validateAuthorization: async (intent, ctx) => {
    validateNearWithdrawAuthorization(intent, ctx, "Burrow withdraw");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;
    const meta = intent.metadata;

    const dry = dryRunResult("burrow-withdraw", intent.intentId, config, { bridgeBack: !!meta.bridgeBack });
    if (dry) return dry;

    if (!intent.userDestination) {
      throw new Error("Burrow withdraw requires userDestination for custody isolation");
    }

    // Derive the user's NEAR agent account
    const userAgent = await deriveNearAgentAccount(NEAR_DEFAULT_PATH, intent.userDestination);

    logNearAddressInfo(logger, intent.userDestination, userAgent);

    // Ensure the implicit account exists (fund it if needed)
    await ensureNearAccountFunded(userAgent.accountId);

    // Verify the token can be withdrawn
    const assets = await getAssetsPagedDetailed();
    const asset = assets.find((a) => a.token_id === meta.tokenId);

    if (!asset) {
      throw new Error(`Token ${meta.tokenId} is not supported by Burrow`);
    }

    if (!asset.config.can_withdraw) {
      throw new Error(`Token ${meta.tokenId} cannot be withdrawn from Burrow`);
    }

    const withdrawAmount = intent.sourceAmount;

    // Build the withdraw transaction using Rhea SDK
    const withdrawTx = await buildWithdrawTransaction({
      token_id: meta.tokenId,
      amount: withdrawAmount,
    });

    logger.info(`Built withdraw tx via Rhea SDK: ${withdrawTx.method_name} on ${withdrawTx.contract_id}`);

    // Execute NEAR transaction (prepare, sign, broadcast)
    const txHash = await executeNearFunctionCall({
      from: userAgent,
      receiverId: withdrawTx.contract_id,
      methodName: withdrawTx.method_name,
      args: withdrawTx.args,
      gas: GAS_FOR_FT_TRANSFER_CALL,
      deposit: ZERO_DEPOSIT,
    });

    logger.info(`Withdraw tx confirmed: ${txHash}`);

    // If bridgeBack is configured, send withdrawn tokens to intents for cross-chain swap
    if (meta.bridgeBack) {
      const bridgeResult = await executeBridgeBack(intent, meta, userAgent, config, logger);
      return {
        txId: txHash,
        bridgeTxId: bridgeResult.txId,
        intentsDepositAddress: bridgeResult.depositAddress,
      };
    }

    return { txId: txHash };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { burrowWithdrawFlow };
