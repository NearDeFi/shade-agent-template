import { SOL_NATIVE_MINT, WRAP_NEAR_CONTRACT } from "../constants";
import { IntentMessage, ValidatedIntent } from "./types";
import type { FlowCatalog } from "../flows/catalog";

const DEFAULT_SLIPPAGE_BPS = 300; // 3% fallback if UI omits slippage
const DEFAULT_DESTINATION_CHAINS: string[] = [
  "solana",
  "ethereum",
  "base",
  "arbitrum",
  "bnb",
];

export type IntentValidator = (message: IntentMessage) => ValidatedIntent;

export function createIntentValidator(flowCatalog: FlowCatalog): IntentValidator {
  return (message: IntentMessage) => validateIntent(message, flowCatalog);
}

export function validateIntent(
  message: IntentMessage,
  flowCatalog: FlowCatalog,
): ValidatedIntent {
  const catalog = flowCatalog;

  if (!message.intentId) throw new Error("intentId missing");

  // Look up the flow from registry (if action is specified)
  const action = message.metadata?.action;
  const flow = typeof action === "string" ? catalog.get(action) : undefined;

  // Validate destination chain based on flow's supported chains
  if (flow) {
    const supportedDestinations = flow.supportedChains.destination;
    if (!supportedDestinations.includes(message.destinationChain)) {
      throw new Error(
        `destinationChain must be one of: ${supportedDestinations.join(", ")} for ${action}`
      );
    }
  } else {
    // Default: solana or EVM chains for unknown/swap flows
    if (!DEFAULT_DESTINATION_CHAINS.includes(message.destinationChain)) {
      throw new Error(
        `destinationChain must be one of: ${DEFAULT_DESTINATION_CHAINS.join(", ")}`,
      );
    }
  }

  // Common field validation
  if (!message.userDestination) throw new Error("userDestination missing");
  if (!message.agentDestination) throw new Error("agentDestination missing");
  if (!message.sourceAsset) throw new Error("sourceAsset missing");
  if (!message.finalAsset) throw new Error("finalAsset missing");
  if (!message.sourceAmount || !/^\d+$/.test(message.sourceAmount)) {
    throw new Error("sourceAmount must be a numeric string in base units");
  }

  // Validate sourceAmount is a reasonable size (max 2^128 to prevent overflow issues)
  try {
    const amount = BigInt(message.sourceAmount);
    if (amount <= 0n) {
      throw new Error("sourceAmount must be positive");
    }
    if (amount > 2n ** 128n) {
      throw new Error("sourceAmount exceeds maximum allowed value");
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("sourceAmount")) throw e;
    throw new Error("sourceAmount is not a valid integer");
  }

  // destinationAmount is optional - if provided, must be numeric string
  if (
    message.destinationAmount !== undefined &&
    !/^\d+$/.test(message.destinationAmount)
  ) {
    throw new Error(
      "destinationAmount must be a numeric string in base units if provided",
    );
  }

  // Registry-driven flow validation
  if (flow) {
    // Check required metadata fields
    for (const field of flow.requiredMetadataFields) {
      if (field === "action") continue; // action already matched
      const value = message.metadata?.[field];
      if (value === undefined || value === "") {
        throw new Error(`${flow.name} requires metadata.${field}`);
      }
    }

    // Run custom validation hook (can sanitize/mutate metadata)
    if (flow.validateMetadata && message.metadata) {
      flow.validateMetadata(message.metadata);
    }
  }

  const intermediateAsset =
    message.intermediateAsset ?? getDefaultIntermediateAsset(message);

  return {
    ...message,
    intermediateAsset,
    slippageBps:
      typeof message.slippageBps === "number"
        ? message.slippageBps
        : DEFAULT_SLIPPAGE_BPS,
  };
}

/** Maps destination chain to native Defuse asset ID used as the intermediate asset */
const EVM_NATIVE_DEFUSE_ASSETS: Record<string, string> = {
  ethereum: "nep141:eth.omft.near",
  base: "nep141:base.omft.near",
  arbitrum: "nep141:arb.omft.near",
  bnb: "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
};

function getDefaultIntermediateAsset(intent: IntentMessage): string | undefined {
  if (intent.destinationChain === "solana") return SOL_NATIVE_MINT;
  if (intent.destinationChain === "near") return WRAP_NEAR_CONTRACT;
  return EVM_NATIVE_DEFUSE_ASSETS[intent.destinationChain];
}
