import { address, type IInstruction } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  fetchToken,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { OrderCancelMetadata, ValidatedIntent } from "../queue/types";
import {
  deriveAgentPublicKey,
  SOLANA_DEFAULT_PATH,
  getSolanaRpc,
  signAndBroadcastSingleSigner,
  buildAndCompileTransaction,
} from "../utils/solana";
import { createDummySigner } from "../utils/chainSignature";
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
  const agentAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, derivationSuffix);

  const rpc = getSolanaRpc();
  const mintAddr = address(sourceAsset);
  const [ata] = await findAssociatedTokenPda({
    mint: mintAddr,
    owner: agentAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  try {
    const account = await fetchToken(rpc, ata);
    return account.data.amount;
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
  const agentAddress = await deriveAgentPublicKey(SOLANA_DEFAULT_PATH, derivationSuffix);
  const userAddr = address(userAddress);

  const rpc = getSolanaRpc();
  const mintAddr = address(sourceAsset);

  const [sourceAta] = await findAssociatedTokenPda({
    mint: mintAddr,
    owner: agentAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [destAta] = await findAssociatedTokenPda({
    mint: mintAddr,
    owner: userAddr,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  logger.info(`Refunding ${amount} to ${userAddress}`);

  const instructions: IInstruction[] = [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: createDummySigner(address(agentAddress)),
      ata: destAta,
      owner: userAddr,
      mint: mintAddr,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }) as IInstruction,
    getTransferInstruction({
      source: sourceAta,
      destination: destAta,
      authority: createDummySigner(agentAddress),
      amount,
    }) as IInstruction,
  ];

  const compiledTx = await buildAndCompileTransaction({
    instructions,
    feePayer: agentAddress,
    rpc,
  });

  if (config.dryRunSwaps) {
    return `dry-run-refund-${orderId}`;
  }

  return signAndBroadcastSingleSigner(compiledTx, derivationSuffix);
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
