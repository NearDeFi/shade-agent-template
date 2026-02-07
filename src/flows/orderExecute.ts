import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { OrderExecuteMetadata, ValidatedIntent } from "../queue/types";
import {
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  getSolanaConnection,
  signAndBroadcastSingleSigner,
} from "../utils/solana";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
  executeNearFunctionCall,
  GAS_FOR_FT_TRANSFER_CALL,
  ONE_YOCTO,
} from "../utils/near";
import { getIntentsQuote, IntentsQuoteRequest } from "../utils/intents";
import {
  getOrder,
  markOrderTriggered,
  markOrderExecuted,
  markOrderFailed,
  transitionOrderState,
  Order,
  getOrderDescription,
} from "../state/orders";
import type { FlowDefinition, FlowContext, FlowResult } from "./types";
// Permission contract temporarily disabled
// import { signAllowed, isOperationAllowed } from "../permission";

// ─── Helper Functions ──────────────────────────────────────────────────────────

// Permission contract temporarily disabled
// /**
//  * Sign transaction via permission contract if available, otherwise direct MPC
//  * This is the key integration point for self-custodial operations
//  */
// async function signOrderTransaction(
//   order: Order,
//   payload: Uint8Array,
//   teePrice: string,
//   ctx: FlowContext,
// ): Promise<Uint8Array> {
//   const { logger } = ctx;
//
//   // If order has permission contract registration, use it
//   if (order.permissionOperationId && order.permissionDerivationPath) {
//     logger.info(`Using permission contract for signing (operation: ${order.permissionOperationId})`);
//
//     // Verify operation is still allowed
//     const allowed = await isOperationAllowed(
//       order.permissionDerivationPath,
//       order.permissionOperationId,
//     );
//
//     if (!allowed) {
//       throw new Error(`Operation ${order.permissionOperationId} is no longer allowed`);
//     }
//
//     // Sign via permission contract (which validates and forwards to MPC)
//     const signature = await signAllowed({
//       derivation_path: order.permissionDerivationPath,
//       operation_id: order.permissionOperationId,
//       payload: Array.from(payload),
//       key_type: order.agentChain === "solana" ? "Eddsa" : "Ecdsa",
//       tee_price: teePrice,
//       tee_timestamp: Date.now(),
//     });
//
//     logger.info(`Received signature via permission contract (${signature.length} bytes)`);
//     return signature;
//   }
//
//   // Fallback to direct MPC signing (less secure, for backward compatibility)
//   logger.warn("Using direct MPC signing (no permission contract registration)");
//
//   // This uses the existing signAndBroadcastSingleSigner which calls MPC directly
//   // For full self-custody, this path should be deprecated
//   throw new Error(
//     "Direct MPC signing not supported for orders without permission registration. " +
//     "Please create the order with a user signature."
//   );
// }

/**
 * Execute Solana transfer to intents for cross-chain swap
 */
async function executeSolanaOrderSwap(
  order: Order,
  depositAddress: string,
  ctx: FlowContext,
): Promise<string> {
  const { logger, config } = ctx;

  const derivationSuffix = `order-${order.orderId}`;
  const agentPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, derivationSuffix);

  logger.info(`Executing order from custody: ${agentPublicKey.toBase58()}`);
  logger.info(`To intents deposit: ${depositAddress}`);
  logger.info(`Amount: ${order.amount}`);

  const connection = getSolanaConnection();

  // Build transfer for SPL tokens
  const mintAddress = new PublicKey(order.sourceAsset);
  const sourceAta = getAssociatedTokenAddressSync(mintAddress, agentPublicKey);
  const depositPubkey = new PublicKey(depositAddress);
  // SPL transfers must target a token account, not a raw wallet address
  const destinationAta = getAssociatedTokenAddressSync(mintAddress, depositPubkey);

  const instructions = [
    createTransferInstruction(
      sourceAta,
      destinationAta,
      agentPublicKey,
      BigInt(order.amount),
    ),
  ];

  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: agentPublicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);

  if (config.dryRunSwaps) {
    logger.info("DRY RUN - Would execute order swap");
    return `dry-run-order-${order.orderId}-${Date.now()}`;
  }

  const txId = await signAndBroadcastSingleSigner(transaction, derivationSuffix);
  logger.info(`Solana order execution confirmed: ${txId}`);

  return txId;
}

/**
 * Execute NEAR transfer to intents for cross-chain swap
 */
async function executeNearOrderSwap(
  order: Order,
  depositAddress: string,
  ctx: FlowContext,
): Promise<string> {
  const { logger, config } = ctx;

  const derivationSuffix = `order-${order.orderId}`;
  const agentAccount = await deriveNearAgentAccount(undefined, derivationSuffix);

  logger.info(`Executing order from custody: ${agentAccount.accountId}`);
  logger.info(`To intents deposit: ${depositAddress}`);
  logger.info(`Amount: ${order.amount}`);

  await ensureNearAccountFunded(agentAccount.accountId);

  if (config.dryRunSwaps) {
    logger.info("DRY RUN - Would execute order swap");
    return `dry-run-order-${order.orderId}-${Date.now()}`;
  }

  const txHash = await executeNearFunctionCall({
    from: agentAccount,
    receiverId: order.sourceAsset,
    methodName: "ft_transfer_call",
    args: {
      receiver_id: depositAddress,
      amount: order.amount,
      msg: "",
    },
    gas: GAS_FOR_FT_TRANSFER_CALL,
    deposit: ONE_YOCTO,
  });

  logger.info(`NEAR order execution confirmed: ${txHash}`);

  return txHash;
}

/**
 * Build intents quote request for order execution
 */
function buildOrderQuoteRequest(order: Order): IntentsQuoteRequest {
  return {
    originAsset: order.sourceAsset,
    destinationAsset: order.targetAsset,
    amount: order.amount,
    recipient: order.userAddress, // Send output to user
    refundAddress: order.agentAddress, // Refund back to custody if failed
    slippageTolerance: order.slippageTolerance,
  };
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

const orderExecuteFlow: FlowDefinition<OrderExecuteMetadata> = {
  action: "order-execute",
  name: "Order Execute",
  description: "Execute a triggered conditional order via cross-chain intents",

  supportedChains: {
    source: ["near", "solana"],
    destination: ["solana", "near", "ethereum", "base", "arbitrum"],
  },

  requiredMetadataFields: ["action", "orderId", "triggeredPrice"],
  optionalMetadataFields: [],

  isMatch: (intent): intent is ValidatedIntent & { metadata: OrderExecuteMetadata } => {
    const meta = intent.metadata as OrderExecuteMetadata | undefined;
    return meta?.action === "order-execute" && !!meta.orderId;
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;
    const meta = intent.metadata;

    logger.info(`Executing order: ${meta.orderId}`);
    logger.info(`Triggered at price: ${meta.triggeredPrice}`);

    // Get order
    let order = await getOrder(meta.orderId);
    if (!order) {
      throw new Error(`Order ${meta.orderId} not found`);
    }

    logger.info(`Order: ${getOrderDescription(order)}`);

    if (order.state === "executed" && order.executionTxId) {
      logger.info(`Order ${meta.orderId} already executed, returning existing tx`, {
        txId: order.executionTxId,
      });
      return { txId: order.executionTxId };
    }

    // Validate order state
    if (order.state !== "active" && order.state !== "triggered") {
      throw new Error(`Order ${meta.orderId} is ${order.state}, cannot execute`);
    }

    if (order.state === "active") {
      order = await markOrderTriggered(meta.orderId, meta.triggeredPrice);
    }

    let txId = order.executionTxId;
    try {
      // Get intents quote for the swap
      const quoteRequest = buildOrderQuoteRequest(order);

      logger.info(`Getting intents quote`, {
        from: order.sourceAsset,
        to: order.targetAsset,
        amount: order.amount,
        recipient: order.userAddress,
      });

      const { depositAddress, quoteResponse } = await getIntentsQuote(quoteRequest, config);

      logger.info(`Got intents deposit address: ${depositAddress}`);

      // Execute the swap once. If we already have an execution tx, avoid rebroadcast.
      if (!txId) {
        if (order.agentChain === "solana") {
          txId = await executeSolanaOrderSwap(order, depositAddress, ctx);
        } else if (order.agentChain === "near") {
          txId = await executeNearOrderSwap(order, depositAddress, ctx);
        } else {
          throw new Error(`Unsupported custody chain: ${order.agentChain}`);
        }

        // Best-effort checkpoint to keep retries idempotent after broadcast.
        try {
          const checkpoint = await transitionOrderState(
            meta.orderId,
            "triggered",
            "triggered",
            { executionTxId: txId },
          );
          if (checkpoint.updated && checkpoint.order) {
            order = checkpoint.order;
          }
        } catch (checkpointError) {
          logger.error(`Failed to persist execution checkpoint for ${meta.orderId}`, {
            err: String(checkpointError),
            txId,
          });
        }
      }

      // Extract output amount from quote if available
      const outputAmount = (quoteResponse as any)?.destinationAmount;

      // Mark as executed. If persistence fails after broadcast, return tx to avoid duplicate sends.
      try {
        await markOrderExecuted(meta.orderId, txId, outputAmount);
      } catch (persistError) {
        logger.error(`Order ${meta.orderId} transfer was broadcast but execution state update failed`, {
          err: String(persistError),
          txId,
        });
      }

      logger.info(`Order ${meta.orderId} executed successfully: ${txId}`);
      logger.info(`Triggered at: ${meta.triggeredPrice}, Output: ${outputAmount || "pending"}`);

      return { txId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!txId) {
        try {
          await markOrderFailed(meta.orderId, errorMessage);
        } catch (markFailedError) {
          logger.error(`Failed to persist failed state for order ${meta.orderId}`, {
            err: String(markFailedError),
          });
        }
      }

      logger.error(`Order ${meta.orderId} execution failed: ${errorMessage}`);

      throw error;
    }
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { orderExecuteFlow };
