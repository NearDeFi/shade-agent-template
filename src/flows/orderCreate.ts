import { OrderCreateMetadata, ValidatedIntent } from "../queue/types";
import { deriveAgentPublicKey, SOLANA_DEFAULT_PATH } from "../utils/solana";
import { deriveNearAgentAccount } from "../utils/near";
import { getPrice, parsePrice } from "../utils/priceFeed";
import {
  requireSupportedOrderCustodyChain,
  validateOrderCreateInput,
} from "../utils/orderValidation";
import { requireUserDestination } from "../utils/authorization";
import {
  createOrder,
  getOrder,
  Order,
  getOrderDescription,
} from "../state/orders";
import type { FlowDefinition, FlowContext, FlowResult } from "./types";
// Permission contract temporarily disabled
// import {
//   addAllowedOperation,
//   createLimitOrderOperation,
//   createStopLossOperation,
//   createTakeProfitOperation,
//   parseWalletType,
//   type AllowedOperationInput,
// } from "../permission";

// Stub types while permission is disabled
type AllowedOperationInput = Record<string, unknown>;

// ─── Helper Functions ──────────────────────────────────────────────────────────

// Permission contract temporarily disabled
// /**
//  * Create permission operation input from order metadata
//  */
// function createOrderPermissionOperation(
//   meta: OrderCreateMetadata,
// ): AllowedOperationInput {
//   const baseParams = {
//     sourceAsset: meta.sourceAsset,
//     targetAsset: meta.targetAsset,
//     maxAmount: meta.amount,
//     destinationAddress: meta.destinationChain, // Will be updated with user address
//     destinationChain: meta.destinationChain,
//     slippageBps: meta.slippageTolerance ?? 300,
//     expiresAt: meta.expiresAt ? meta.expiresAt * 1_000_000 : undefined, // Convert ms to ns
//   };
//
//   const priceParams = {
//     priceAsset: meta.priceAsset,
//     quoteAsset: meta.quoteAsset,
//     triggerPrice: meta.triggerPrice,
//   };
//
//   if (meta.orderType === "limit") {
//     return createLimitOrderOperation({
//       ...baseParams,
//       ...priceParams,
//       condition: meta.priceCondition === "above" ? "Above" : "Below",
//     });
//   } else if (meta.orderType === "stop-loss") {
//     return createStopLossOperation({
//       ...baseParams,
//       ...priceParams,
//     });
//   } else if (meta.orderType === "take-profit") {
//     return createTakeProfitOperation({
//       ...baseParams,
//       ...priceParams,
//     });
//   }
//
//   throw new Error(`Unknown order type: ${meta.orderType}`);
// }

// Permission contract temporarily disabled
// /**
//  * Register order as allowed operation on permission contract
//  * This is optional - if no signature is provided, we skip permission registration
//  */
// async function registerOrderOnPermissionContract(
//   orderId: string,
//   derivationPath: string,
//   operation: AllowedOperationInput,
//   signature: string,
//   message: string,
//   logger: FlowContext["logger"],
// ): Promise<string | null> {
//   try {
//     const signatureBytes = Buffer.from(signature.replace("0x", ""), "hex");
//     const messageBytes = Buffer.from(message, "utf8");
//
//     const { txHash, operationId } = await addAllowedOperation({
//       derivation_path: derivationPath,
//       operation,
//       signature: Array.from(signatureBytes),
//       message: Array.from(messageBytes),
//     });
//
//     logger.info(`Registered order on permission contract: ${operationId} (tx: ${txHash})`);
//     return operationId;
//   } catch (error) {
//     logger.error(`Failed to register on permission contract: ${error}`);
//     throw error;
//   }
// }

/**
 * Derive the agent custody address for an order
 */
async function deriveOrderAgentAddress(
  orderId: string,
  chain: "solana" | "near",
): Promise<string> {
  const derivationSuffix = `order-${orderId}`;

  if (chain === "solana") {
    const publicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, derivationSuffix);
    return publicKey.toBase58();
  } else if (chain === "near") {
    const { accountId } = await deriveNearAgentAccount(undefined, derivationSuffix);
    return accountId;
  }

  throw new Error(`Unsupported order custody chain: ${chain}`);
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

const orderCreateFlow: FlowDefinition<OrderCreateMetadata> = {
  action: "order-create",
  name: "Order Create",
  description: "Create a conditional order (limit, stop-loss, or take-profit)",

  supportedChains: {
    source: ["near", "ethereum", "base", "arbitrum", "solana"],
    destination: ["solana", "near", "ethereum", "base", "arbitrum"],
  },

  requiredMetadataFields: [
    "action",
    "orderId",
    "orderType",
    "side",
    "priceAsset",
    "quoteAsset",
    "triggerPrice",
    "priceCondition",
    "sourceChain",
    "sourceAsset",
    "amount",
    "destinationChain",
    "targetAsset",
  ],
  optionalMetadataFields: ["expiresAt", "slippageTolerance"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: OrderCreateMetadata } => {
    const meta = intent.metadata as OrderCreateMetadata | undefined;
    return (
      meta?.action === "order-create" &&
      !!meta.orderId &&
      !!meta.orderType &&
      !!meta.triggerPrice
    );
  },

  validateMetadata: (metadata) => {
    validateOrderCreateInput(metadata, { requireUserDestination: false });
  },

  validateAuthorization: async (intent, ctx) => {
    requireUserDestination(intent, ctx, "Order create");
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;
    const meta = intent.metadata;

    logger.info(`Creating ${meta.orderType} order: ${meta.orderId}`);
    logger.info(`${meta.side.toUpperCase()} when ${meta.priceAsset} ${meta.priceCondition} ${meta.triggerPrice} ${meta.quoteAsset}`);

    // Check if order already exists
    const existing = await getOrder(meta.orderId);
    if (existing) {
      if (existing.state === "active") {
        logger.info(`Order ${meta.orderId} already exists and is active`);
        return { txId: `existing-order-${meta.orderId}` };
      }
      throw new Error(`Order ${meta.orderId} already exists in state: ${existing.state}`);
    }

    // Get current price to show user how far from trigger
    try {
      const currentPrice = await getPrice(meta.priceAsset, meta.quoteAsset);
      const triggerPrice = parsePrice(meta.triggerPrice);
      const priceDiff = ((triggerPrice - currentPrice.price) / currentPrice.price * 100).toFixed(2);
      logger.info(`Current ${meta.priceAsset} price: ${currentPrice.price} ${meta.quoteAsset} (${priceDiff}% from trigger)`);
    } catch (error) {
      logger.warn(`Could not fetch current price: ${error}`);
    }

    const custodyChain = requireSupportedOrderCustodyChain(meta.sourceChain);

    // Derive custody address
    const agentAddress = await deriveOrderAgentAddress(meta.orderId, custodyChain);
    logger.info(`Derived order custody address: ${agentAddress} (${custodyChain})`);

    // Create derivation path for this order's MPC key
    const derivationPath = `${custodyChain}-1,order-${meta.orderId}`;

    // Create order record
    const order: Order = {
      orderId: meta.orderId,
      state: "pending",

      orderType: meta.orderType,
      side: meta.side,

      priceAsset: meta.priceAsset,
      quoteAsset: meta.quoteAsset,
      triggerPrice: meta.triggerPrice,
      priceCondition: meta.priceCondition,

      sourceChain: meta.sourceChain,
      sourceAsset: meta.sourceAsset,
      amount: meta.amount,
      destinationChain: meta.destinationChain,
      targetAsset: meta.targetAsset,

      userAddress: intent.userDestination!,
      userChain: intent.sourceChain,

      agentAddress,
      agentChain: custodyChain,

      slippageTolerance: meta.slippageTolerance ?? 300,
      expiresAt: meta.expiresAt,

      createdAt: Date.now(),
      createIntentId: intent.intentId,
      permissionDerivationPath: derivationPath,
    };

    // Permission contract temporarily disabled
    // // If user signature is provided, register on permission contract
    // // This enables self-custodial operation signing
    // if (intent.userSignature) {
    //   logger.info("User signature provided, registering on permission contract...");
    //
    //   try {
    //     const permissionOp = createOrderPermissionOperation(meta);
    //     // Update destination address to user's address
    //     permissionOp.destination_address = intent.userDestination!;
    //
    //     const operationId = await registerOrderOnPermissionContract(
    //       meta.orderId,
    //       derivationPath,
    //       permissionOp,
    //       intent.userSignature.signature,
    //       intent.userSignature.message,
    //       logger,
    //     );
    //
    //     order.permissionOperationId = operationId || undefined;
    //     logger.info(`Order registered on permission contract: ${operationId}`);
    //   } catch (error) {
    //     logger.error(`Failed to register on permission contract: ${error}`);
    //     // Continue without permission registration - order can still work
    //     // but will use direct MPC signing (less secure)
    //   }
    // } else {
    //   logger.warn("No user signature provided - order will use direct MPC signing");
    // }

    await createOrder(order);
    logger.info(`Created order: ${getOrderDescription(order)}`);

    // Handle funding
    if (intent.intentsDepositAddress) {
      await ctx.setStatus("awaiting_intents", {
        orderId: meta.orderId,
        depositAddress: agentAddress,
        message: `Awaiting ${meta.amount} deposit via intents`,
      });

      return {
        txId: `awaiting-funding-${meta.orderId}`,
        intentsDepositAddress: intent.intentsDepositAddress,
      };
    }

    // Same-chain deposit
    await ctx.setStatus("awaiting_deposit", {
      orderId: meta.orderId,
      depositAddress: agentAddress,
      expectedAmount: meta.amount,
      message: `Send ${meta.amount} ${meta.sourceAsset} to ${agentAddress} to activate order`,
    });

    logger.info(`Order ${meta.orderId} created, awaiting deposit to ${agentAddress}`);
    if (meta.expiresAt) {
      logger.info(`Order expires: ${new Date(meta.expiresAt).toISOString()}`);
    }

    return {
      txId: `order-created-${meta.orderId}`,
      intentsDepositAddress: agentAddress,
    };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { orderCreateFlow, deriveOrderAgentAddress };
