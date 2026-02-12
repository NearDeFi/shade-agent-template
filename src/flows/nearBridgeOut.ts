import { NearBridgeOutMetadata, ValidatedIntent } from "../queue/types";
import { WRAP_NEAR_CONTRACT } from "../constants";
import {
  deriveNearAgentAccount,
  ensureNearAccountFunded,
  executeNearFunctionCall,
  NEAR_DEFAULT_PATH,
  GAS_FOR_FT_TRANSFER_CALL,
  ONE_YOCTO,
} from "../utils/near";
import { getFtBalance as getFtBalanceStr } from "../utils/nearRpc";
import { buildRefSwapTransactions, DEFAULT_REF_GAS } from "../utils/refFinance";
import { getDefuseAssetId } from "../utils/tokenMappings";
import { getIntentsQuote, createBridgeBackQuoteRequest } from "../utils/intents";
import { logNearAddressInfo, dryRunResult } from "./context";
import type { FlowDefinition, FlowContext, FlowResult, AppConfig, Logger } from "./types";

// ─── Helper Functions ──────────────────────────────────────────────────────────

async function getFtBalance(tokenId: string, accountId: string): Promise<bigint> {
  const balance = await getFtBalanceStr(tokenId, accountId);
  return BigInt(balance);
}

// ─── Flow Definition ───────────────────────────────────────────────────────────

const nearBridgeOutFlow: FlowDefinition<NearBridgeOutMetadata> = {
  action: "near-bridge-out",
  name: "NEAR Bridge Out",
  description: "Sell a NEAR token: swap to wNEAR via Ref Finance, then bridge out via Defuse Intents",

  supportedChains: {
    source: ["near"],
    destination: ["near", "ethereum", "base", "arbitrum", "solana", "optimism", "aurora", "polygon", "bnb", "avalanche"],
  },

  requiredMetadataFields: ["action", "userNearAddress", "userTxHash", "userTxConfirmed", "tokenId", "destinationChain", "destinationAddress", "destinationAsset"],
  optionalMetadataFields: ["slippageTolerance"],

  isMatch: (intent): intent is ValidatedIntent & { metadata: NearBridgeOutMetadata } => {
    const meta = intent.metadata as NearBridgeOutMetadata | undefined;
    return (
      meta?.action === "near-bridge-out" &&
      !!meta.userTxConfirmed &&
      !!meta.userNearAddress &&
      !!meta.destinationAddress
    );
  },

  execute: async (intent, ctx): Promise<FlowResult> => {
    const { config, logger } = ctx;
    const meta = intent.metadata;

    // Derive agent's NEAR account using the user's NEAR address for custody isolation
    const userAgent = await deriveNearAgentAccount(NEAR_DEFAULT_PATH, meta.userNearAddress);

    logNearAddressInfo(logger, meta.userNearAddress, userAgent);

    // Ensure the implicit account exists
    await ensureNearAccountFunded(userAgent.accountId);

    const dry = dryRunResult("near-bridge-out", intent.intentId, config, { bridgeBack: true });
    if (dry) return dry;

    const txIds: string[] = [];
    const tokenId = meta.tokenId;
    const isAlreadyWnear = tokenId === WRAP_NEAR_CONTRACT;
    let preWnearBalance = 0n;

    // Step 1: Swap token → wNEAR via Ref Finance (skip if already wNEAR)
    if (!isAlreadyWnear) {
      preWnearBalance = await getFtBalance(WRAP_NEAR_CONTRACT, userAgent.accountId);
      logger.info(`Swapping ${tokenId} → wNEAR via Ref Finance`);

      const transactions = await buildRefSwapTransactions({
        inputToken: tokenId,
        outputToken: WRAP_NEAR_CONTRACT,
        amount: intent.sourceAmount,
        slippageBps: intent.slippageBps,
        accountId: userAgent.accountId,
        logger,
      });

      logger.info(`Got ${transactions.length} transactions from Ref SDK`);

      for (let i = 0; i < transactions.length; i++) {
        const refTx = transactions[i];
        logger.info(`Executing swap tx ${i + 1}/${transactions.length} to ${refTx.receiverId}`);

        for (const functionCall of refTx.functionCalls) {
          const txId = await executeNearFunctionCall({
            from: userAgent,
            receiverId: refTx.receiverId,
            methodName: functionCall.methodName,
            args: (functionCall.args || {}) as Record<string, unknown>,
            gas: functionCall.gas ? BigInt(functionCall.gas) : DEFAULT_REF_GAS,
            deposit: functionCall.amount ? BigInt(functionCall.amount) : BigInt(0),
          });

          txIds.push(txId);
          logger.info(`Swap tx confirmed: ${txId}`);
        }
      }

      logger.info(`Swap completed with ${txIds.length} transactions`);
    } else {
      logger.info(`Token is already wNEAR, skipping swap step`);
    }

    // Step 2: Determine how much wNEAR to bridge
    let bridgeAmount: bigint;
    if (isAlreadyWnear) {
      bridgeAmount = BigInt(intent.sourceAmount);
      const currentBalance = await getFtBalance(WRAP_NEAR_CONTRACT, userAgent.accountId);
      if (currentBalance < bridgeAmount) {
        throw new Error(
          `Insufficient wNEAR balance. Needed ${bridgeAmount.toString()}, available ${currentBalance.toString()}`,
        );
      }
    } else {
      const postWnearBalance = await getFtBalance(WRAP_NEAR_CONTRACT, userAgent.accountId);
      bridgeAmount = postWnearBalance - preWnearBalance;
      if (bridgeAmount <= 0n) {
        throw new Error("Swap completed but no wNEAR received to bridge");
      }
    }

    const bridgeAmountStr = bridgeAmount.toString();

    // Step 3: Get Defuse deposit address for the bridge
    const originAsset = getDefuseAssetId("near", WRAP_NEAR_CONTRACT) || `nep141:${WRAP_NEAR_CONTRACT}`;
    const quoteRequest = createBridgeBackQuoteRequest(
      {
        destinationChain: meta.destinationChain,
        destinationAddress: meta.destinationAddress,
        destinationAsset: meta.destinationAsset,
        slippageTolerance: meta.slippageTolerance,
      },
      originAsset,
      bridgeAmountStr,
      userAgent.accountId, // Refund to agent if bridge fails
    );

    const { depositAddress } = await getIntentsQuote(quoteRequest, config);

    logger.info(`Got Defuse deposit address: ${depositAddress}`);

    // Step 4: ft_transfer_call wNEAR to Defuse deposit address
    const bridgeTxHash = await executeNearFunctionCall({
      from: userAgent,
      receiverId: WRAP_NEAR_CONTRACT,
      methodName: "ft_transfer_call",
      args: {
        receiver_id: depositAddress,
        amount: bridgeAmountStr,
        msg: "",
      },
      gas: GAS_FOR_FT_TRANSFER_CALL,
      deposit: ONE_YOCTO,
    });

    txIds.push(bridgeTxHash);
    logger.info(`Bridge transfer tx confirmed: ${bridgeTxHash}`);

    return {
      txId: txIds[0],
      bridgeTxId: bridgeTxHash,
      intentsDepositAddress: depositAddress,
      txIds,
    };
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

export { nearBridgeOutFlow };
