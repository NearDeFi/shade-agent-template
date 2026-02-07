import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { OrderCancelMetadata, ValidatedIntent } from "../queue/types";
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
  getNearProvider,
} from "../utils/near";
import {
  getOrder,
  setOrderState,
  Order,
} from "../state/orders";
import type { FlowDefinition, FlowContext, FlowResult } from "./types";

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Get remaining balance in Solana custody
 */
async function getSolanaRemainingBalance(
  orderId: string,
  sourceAsset: string,
): Promise<bigint> {
  const derivationSuffix = `order-${orderId}`;
  const agentPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, derivationSuffix);

  const connection = getSolanaConnection();
  const mintAddress = new PublicKey(sourceAsset);
  const ata = getAssociatedTokenAddressSync(mintAddress, agentPublicKey);

  try {
    const account = await getAccount(connection, ata);
    return account.amount;
  } catch {
    return 0n;
  }
}

/**
 * Refund Solana tokens to user
 */
async function refundSolanaTokens(
  orderId: string,
  sourceAsset: string,
  userAddress: string,
  amount: bigint,
  ctx: FlowContext,
): Promise<string> {
  const { logger, config } = ctx;

  const derivationSuffix = `order-${orderId}`;
  const agentPublicKey = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, derivationSuffix);
  const userPublicKey = new PublicKey(userAddress);

  const connection = getSolanaConnection();
  const mintAddress = new PublicKey(sourceAsset);
  const sourceAta = getAssociatedTokenAddressSync(mintAddress, agentPublicKey);
  const destAta = getAssociatedTokenAddressSync(mintAddress, userPublicKey);

  logger.info(`Refunding ${amount} to ${userAddress}`);

  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      agentPublicKey,
      destAta,
      userPublicKey,
      mintAddress,
    ),
    createTransferInstruction(
      sourceAta,
      destAta,
      agentPublicKey,
      amount,
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
    return `dry-run-refund-${orderId}`;
  }

  return signAndBroadcastSingleSigner(transaction, derivationSuffix);
}

/**
 * Get remaining balance in NEAR custody
 */
async function getNearRemainingBalance(
  orderId: string,
  sourceAsset: string,
): Promise<string> {
  const derivationSuffix = `order-${orderId}`;
  const agentAccount = await deriveNearAgentAccount(undefined, derivationSuffix);

  const provider = getNearProvider();

  try {
    const result = await provider.query({
      request_type: "call_function",
      finality: "final",
      account_id: sourceAsset,
      method_name: "ft_balance_of",
      args_base64: Buffer.from(JSON.stringify({ account_id: agentAccount.accountId })).toString("base64"),
    });

    const balance = JSON.parse(Buffer.from((result as unknown as { result: number[] }).result).toString());
    return balance;
  } catch {
    return "0";
  }
}

/**
 * Refund NEAR tokens to user
 */
async function refundNearTokens(
  orderId: string,
  sourceAsset: string,
  userAddress: string,
  amount: string,
  ctx: FlowContext,
): Promise<string> {
  const { logger, config } = ctx;

  const derivationSuffix = `order-${orderId}`;
  const agentAccount = await deriveNearAgentAccount(undefined, derivationSuffix);

  logger.info(`Refunding ${amount} to ${userAddress}`);

  await ensureNearAccountFunded(agentAccount.accountId);

  if (config.dryRunSwaps) {
    return `dry-run-refund-${orderId}`;
  }

  return executeNearFunctionCall({
    from: agentAccount,
    receiverId: sourceAsset,
    methodName: "ft_transfer",
    args: {
      receiver_id: userAddress,
      amount: amount,
      memo: `Order ${orderId} cancelled - refund`,
    },
    gas: GAS_FOR_FT_TRANSFER_CALL,
    deposit: ONE_YOCTO,
  });
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

const orderCancelFlow: FlowDefinition<OrderCancelMetadata> = {
  action: "order-cancel",
  name: "Order Cancel",
  description: "Cancel an active order and optionally refund funds",

  supportedChains: {
    source: ["near", "solana"],
    destination: ["solana", "near"],
  },

  requiredMetadataFields: ["action", "orderId"],
  optionalMetadataFields: ["refundFunds"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: OrderCancelMetadata } => {
    const meta = intent.metadata as OrderCancelMetadata | undefined;
    return meta?.action === "order-cancel" && !!meta.orderId;
  },

  validateAuthorization: async (intent, ctx) => {
    const meta = intent.metadata as OrderCancelMetadata;
    const order = await getOrder(meta.orderId);

    if (!order) {
      throw new Error(`Order ${meta.orderId} not found`);
    }

    // Only the owner can cancel
    if (intent.userDestination !== order.userAddress) {
      throw new Error("Only the order owner can cancel this order");
    }
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { logger } = ctx;
    const meta = intent.metadata;

    logger.info(`Cancelling order: ${meta.orderId}`);

    const order = await getOrder(meta.orderId);
    if (!order) {
      throw new Error(`Order ${meta.orderId} not found`);
    }

    // Check if already cancelled or executed
    if (order.state === "cancelled") {
      return { txId: `already-cancelled-${meta.orderId}` };
    }
    if (order.state === "executed") {
      throw new Error("Cannot cancel an executed order");
    }

    let refundTxId: string | undefined;

    // Handle refund if requested (default true)
    if (meta.refundFunds !== false) {
      logger.info("Processing refund");

      if (order.agentChain === "solana") {
        const remaining = await getSolanaRemainingBalance(meta.orderId, order.sourceAsset);
        if (remaining > 0n) {
          refundTxId = await refundSolanaTokens(
            meta.orderId,
            order.sourceAsset,
            order.userAddress,
            remaining,
            ctx,
          );
          logger.info(`Refunded ${remaining} tokens: ${refundTxId}`);
        } else {
          logger.info("No remaining balance to refund");
        }
      } else if (order.agentChain === "near") {
        const remaining = await getNearRemainingBalance(meta.orderId, order.sourceAsset);
        if (remaining !== "0" && BigInt(remaining) > 0n) {
          refundTxId = await refundNearTokens(
            meta.orderId,
            order.sourceAsset,
            order.userAddress,
            remaining,
            ctx,
          );
          logger.info(`Refunded ${remaining} tokens: ${refundTxId}`);
        } else {
          logger.info("No remaining balance to refund");
        }
      }
    }

    // Mark as cancelled
    await setOrderState(meta.orderId, "cancelled");

    logger.info(`Order ${meta.orderId} cancelled`);

    return {
      txId: refundTxId || `cancelled-${meta.orderId}`,
    };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { orderCancelFlow };
