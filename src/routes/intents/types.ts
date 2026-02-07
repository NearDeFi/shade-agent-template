import type { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import type { IntentChain } from "../../queue/types";

export type QuoteRequestBody = QuoteRequest & {
  // Additional fields for intent enqueuing (required when dry: false)
  sourceChain?: IntentChain;
  userDestination?: string;
  metadata?: Record<string, unknown>;
  // Kamino-specific fields
  kaminoDeposit?: {
    marketAddress: string;
    mintAddress: string;
  };
  // Burrow-specific fields
  burrowDeposit?: {
    tokenId: string;
    isCollateral?: boolean;
  };
  burrowWithdraw?: {
    tokenId: string;
    bridgeBack?: {
      destinationChain: string;
      destinationAddress: string;
      destinationAsset: string;
      slippageTolerance?: number;
    };
  };
  // Aave V3 fields
  aaveDeposit?: boolean;
  aaveWithdraw?: {
    underlyingAsset: string;
    bridgeBack?: {
      destinationChain: string;
      destinationAddress: string;
      destinationAsset: string;
      slippageTolerance?: number;
    };
  };
  // Morpho Blue fields
  morphoDeposit?: {
    marketId: string;
    loanToken: string;
    collateralToken: string;
    oracle: string;
    irm: string;
    lltv: string;
  };
  morphoWithdraw?: {
    marketId: string;
    loanToken: string;
    collateralToken: string;
    oracle: string;
    irm: string;
    lltv: string;
    bridgeBack?: {
      destinationChain: string;
      destinationAddress: string;
      destinationAsset: string;
      slippageTolerance?: number;
    };
  };
  // Sell flow fields: user sells a Solana token, agent bridges SOL out
  /** User's Solana wallet address (signer of the Jupiter sell TX) */
  userSourceAddress?: string;
  /** Destination chain for the sell output (e.g., "near", "ethereum") */
  sellDestinationChain?: string;
  /** User's address on the destination chain */
  sellDestinationAddress?: string;
  /** Defuse asset ID for the destination asset */
  sellDestinationAsset?: string;
  // NEAR sell flow fields: user sells a NEAR token, agent bridges wNEAR out
  /** User's NEAR wallet address (signals NEAR sell flow) */
  userNearAddress?: string;
};

export interface IntentsQuoteResponse {
  timestamp?: string;
  signature?: string;
  quoteRequest?: Record<string, unknown>;
  quote: Record<string, any>;
}
