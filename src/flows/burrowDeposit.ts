import { BurrowDepositMetadata, ValidatedIntent } from "../queue/types";
import {
  getAssetsPagedDetailed,
  buildSupplyTransaction,
} from "../utils/burrow";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
  executeNearFunctionCall,
  NEAR_DEFAULT_PATH,
  GAS_FOR_FT_TRANSFER_CALL,
  ONE_YOCTO,
} from "../utils/near";
import { logNearAddressInfo, dryRunResult } from "./context";
import { requireUserDestination } from "../utils/authorization";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig } from "./types";

// ─── Flow Definition ───────────────────────────────────────────────────────────

const burrowDepositFlow: FlowDefinition<BurrowDepositMetadata> = {
  action: "burrow-deposit",
  name: "Burrow Deposit",
  description: "Deposit tokens into Burrow lending protocol on NEAR",

  supportedChains: {
    source: ["near", "ethereum", "base", "arbitrum", "solana"],
    destination: ["near"],
  },

  requiredMetadataFields: ["action", "tokenId"],
  optionalMetadataFields: ["isCollateral", "useIntents", "targetDefuseAssetId", "slippageTolerance"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: BurrowDepositMetadata } => {
    const meta = intent.metadata as BurrowDepositMetadata | undefined;
    return meta?.action === "burrow-deposit" && !!meta.tokenId;
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
      throw new Error("Burrow deposit tokenId must be a valid NEAR contract address");
    }
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "Burrow deposit");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;
    const meta = intent.metadata;

    const dry = dryRunResult("burrow-deposit", intent.intentId, config, {
      intentsDepositAddress: meta.useIntents ? "dry-run-deposit-address" : undefined,
      swappedAmount: meta.useIntents ? intent.sourceAmount : undefined,
    });
    if (dry) return dry;

    const depositAmount = intent.intermediateAmount || intent.sourceAmount;
    let intentsDepositAddress: string | undefined;

    // Derive the user's NEAR agent account
    const userAgent = await deriveNearAgentAccount(NEAR_DEFAULT_PATH, intent.userDestination);

    logNearAddressInfo(logger, intent.userDestination, userAgent);

    // Ensure the implicit account exists (fund it if needed)
    await ensureNearAccountFunded(userAgent.accountId);

    // Verify the token can be deposited
    const assets = await getAssetsPagedDetailed();
    const asset = assets.find((a) => a.token_id === meta.tokenId);

    if (!asset) {
      throw new Error(`Token ${meta.tokenId} is not supported by Burrow`);
    }

    if (!asset.config.can_deposit) {
      throw new Error(`Token ${meta.tokenId} cannot be deposited to Burrow`);
    }

    if (meta.isCollateral && !asset.config.can_use_as_collateral) {
      throw new Error(`Token ${meta.tokenId} cannot be used as collateral`);
    }

    // Build the supply transaction using Rhea SDK
    const supplyTx = await buildSupplyTransaction({
      token_id: meta.tokenId,
      amount: depositAmount,
      is_collateral: meta.isCollateral ?? false,
    });

    logger.info(`Built supply tx via Rhea SDK: ${supplyTx.method_name} on ${supplyTx.contract_id}`);

    // Execute NEAR transaction (prepare, sign, broadcast)
    const txHash = await executeNearFunctionCall({
      from: userAgent,
      receiverId: supplyTx.contract_id,
      methodName: supplyTx.method_name,
      args: supplyTx.args,
      gas: GAS_FOR_FT_TRANSFER_CALL,
      deposit: ONE_YOCTO,
    });

    logger.info(`Deposit tx confirmed: ${txHash}`);

    return {
      txId: txHash,
      intentsDepositAddress,
      swappedAmount: depositAmount,
    };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { burrowDepositFlow };
