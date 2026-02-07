export type IntentChain = "near" | "solana" | "zcash" | "ethereum" | "arbitrum" | "base" | "optimism" | "aurora" | "polygon" | "bnb" | "avalanche";

export interface KaminoDepositMetadata extends Record<string, unknown> {
  action: "kamino-deposit";
  marketAddress: string;
  /** The raw Solana mint address of the underlying asset */
  mintAddress: string;
  /** The Defuse asset ID for the target asset (e.g., "1cs_v1:sol:spl:EPj...:6") */
  targetDefuseAssetId?: string;
  /** If true, use intents to bridge sourceAsset to the pool's target asset first */
  useIntents?: boolean;
  /** Slippage tolerance in basis points for the intents swap */
  slippageTolerance?: number;
}

export interface KaminoWithdrawMetadata extends Record<string, unknown> {
  action: "kamino-withdraw";
  marketAddress: string;
  mintAddress: string;
  /** Optional: bridge withdrawn tokens back to another chain via intents */
  bridgeBack?: {
    /** Destination chain for the bridge (e.g., "zcash") */
    destinationChain: string;
    /** User's address on the destination chain */
    destinationAddress: string;
    /** Destination asset identifier (e.g., "zec:zec") */
    destinationAsset: string;
    /** Optional slippage tolerance in basis points */
    slippageTolerance?: number;
  };
}

export interface BurrowDepositMetadata extends Record<string, unknown> {
  action: "burrow-deposit";
  /** The NEAR token contract address (e.g., "wrap.near", "usdc.token.near") */
  tokenId: string;
  /** Whether to use deposited tokens as collateral */
  isCollateral?: boolean;
  /** If true, use intents to bridge sourceAsset to the target token first */
  useIntents?: boolean;
  /** The Defuse asset ID for the target NEAR token */
  targetDefuseAssetId?: string;
  /** Slippage tolerance in basis points for the intents swap */
  slippageTolerance?: number;
}

export interface BurrowWithdrawMetadata extends Record<string, unknown> {
  action: "burrow-withdraw";
  /** The NEAR token contract address (e.g., "wrap.near", "usdc.token.near") */
  tokenId: string;
  /** Optional: bridge withdrawn tokens back to another chain via intents */
  bridgeBack?: {
    /** Destination chain for the bridge (e.g., "zcash", "ethereum") */
    destinationChain: string;
    /** User's address on the destination chain */
    destinationAddress: string;
    /** Destination asset identifier (e.g., "zec:zec") */
    destinationAsset: string;
    /** Optional slippage tolerance in basis points */
    slippageTolerance?: number;
  };
}

export interface NearSwapMetadata extends Record<string, unknown> {
  action: "near-swap";
  /** Input token contract address (e.g., "wrap.near", "usdc.token.near") */
  tokenIn: string;
  /** Output token contract address */
  tokenOut: string;
}

export interface EvmSwapMetadata extends Record<string, unknown> {
  action: "evm-swap";
}

export interface AaveDepositMetadata extends Record<string, unknown> {
  action: "aave-deposit";
}

export interface AaveWithdrawMetadata extends Record<string, unknown> {
  action: "aave-withdraw";
  /** EVM token address of the underlying asset to withdraw */
  underlyingAsset: string;
  /** Optional: bridge withdrawn tokens back to another chain via intents */
  bridgeBack?: {
    destinationChain: string;
    destinationAddress: string;
    destinationAsset: string;
    slippageTolerance?: number;
  };
}

export interface MorphoDepositMetadata extends Record<string, unknown> {
  action: "morpho-deposit";
  /** bytes32 market identifier */
  marketId: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  /** uint256 as string */
  lltv: string;
}

export interface MorphoWithdrawMetadata extends Record<string, unknown> {
  action: "morpho-withdraw";
  /** bytes32 market identifier */
  marketId: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  /** uint256 as string */
  lltv: string;
  /** Optional: bridge withdrawn tokens back to another chain via intents */
  bridgeBack?: {
    destinationChain: string;
    destinationAddress: string;
    destinationAsset: string;
    slippageTolerance?: number;
  };
}

// ─── Conditional Order Types ─────────────────────────────────────────────────

export type OrderType = "limit" | "stop-loss" | "take-profit";
export type OrderSide = "buy" | "sell";
export type PriceCondition = "above" | "below";

export interface OrderCreateMetadata extends Record<string, unknown> {
  action: "order-create";
  /** Unique order identifier */
  orderId: string;
  /** Type of order */
  orderType: OrderType;
  /** Buy or sell */
  side: OrderSide;
  /** Asset to monitor price of (the "base" asset, e.g., SOL) */
  priceAsset: string;
  /** Asset to quote price in (e.g., USDC) */
  quoteAsset: string;
  /** Trigger price in quote asset units (e.g., "150.50" for $150.50) */
  triggerPrice: string;
  /** Price condition: execute when price goes above or below trigger */
  priceCondition: PriceCondition;
  /** Source chain where funds are held */
  sourceChain: IntentChain;
  /** Source asset to swap from */
  sourceAsset: string;
  /** Amount to swap */
  amount: string;
  /** Destination chain for output */
  destinationChain: IntentChain;
  /** Target asset to receive */
  targetAsset: string;
  /** Optional: expiry timestamp (Unix ms). Order cancelled if not triggered by then. */
  expiresAt?: number;
  /** Optional: slippage tolerance in basis points */
  slippageTolerance?: number;
}

export interface OrderExecuteMetadata extends Record<string, unknown> {
  action: "order-execute";
  /** The order ID to execute */
  orderId: string;
  /** Price at which the order was triggered */
  triggeredPrice: string;
}

export interface OrderCancelMetadata extends Record<string, unknown> {
  action: "order-cancel";
  /** The order ID to cancel */
  orderId: string;
  /** If true, refund funds to user */
  refundFunds?: boolean;
}

export interface SolBridgeOutMetadata extends Record<string, unknown> {
  action: "sol-bridge-out";
  /** User's Solana wallet (Jupiter TX signer) */
  userSourceAddress: string;
  /** Confirmed Jupiter swap TX hash */
  userTxHash: string;
  /** Whether the user's Jupiter TX has been confirmed on-chain */
  userTxConfirmed: boolean;
  /** Destination chain to bridge SOL to (e.g., "near", "ethereum") */
  destinationChain: string;
  /** User's address on the destination chain */
  destinationAddress: string;
  /** Defuse asset ID for the destination asset */
  destinationAsset: string;
  /** Optional slippage tolerance in basis points */
  slippageTolerance?: number;
}

export interface NearBridgeOutMetadata extends Record<string, unknown> {
  action: "near-bridge-out";
  /** User's NEAR wallet address */
  userNearAddress: string;
  /** Confirmed ft_transfer TX hash */
  userTxHash: string;
  /** Whether the user's ft_transfer TX has been confirmed on-chain */
  userTxConfirmed: boolean;
  /** NEP-141 token contract (e.g., "usdt.tether-token.near") */
  tokenId: string;
  /** Destination chain to bridge to (e.g., "ethereum", "solana") */
  destinationChain: string;
  /** User's address on the destination chain */
  destinationAddress: string;
  /** Defuse asset ID for the destination asset */
  destinationAsset: string;
  /** Optional slippage tolerance in basis points */
  slippageTolerance?: number;
}

/** Cross-cutting metadata flags set by the intents poller and confirm handler */
export interface IntentMetadataFlags {
  /** Set to true by intentsPoller when the bridge leg completes */
  intentsCompleted?: boolean;
  /** Set to true by confirm handler when the user's sell TX is verified on-chain */
  userTxConfirmed?: boolean;
}

export type IntentMetadata =
  | (KaminoDepositMetadata & IntentMetadataFlags)
  | (KaminoWithdrawMetadata & IntentMetadataFlags)
  | (BurrowDepositMetadata & IntentMetadataFlags)
  | (BurrowWithdrawMetadata & IntentMetadataFlags)
  | (NearSwapMetadata & IntentMetadataFlags)
  | (EvmSwapMetadata & IntentMetadataFlags)
  | (AaveDepositMetadata & IntentMetadataFlags)
  | (AaveWithdrawMetadata & IntentMetadataFlags)
  | (MorphoDepositMetadata & IntentMetadataFlags)
  | (MorphoWithdrawMetadata & IntentMetadataFlags)
  | (SolBridgeOutMetadata & IntentMetadataFlags)
  | (NearBridgeOutMetadata & IntentMetadataFlags)
  | (OrderCreateMetadata & IntentMetadataFlags)
  | (OrderExecuteMetadata & IntentMetadataFlags)
  | (OrderCancelMetadata & IntentMetadataFlags)
  | (Record<string, unknown> & IntentMetadataFlags);

export interface IntentMessage {
  intentId: string;
  sourceChain: IntentChain;
  sourceAsset: string;
  sourceAmount: string;
  destinationChain: IntentChain;
  intermediateAsset?: string;
  /** Amount in intermediate asset units (e.g., lamports for SOL) after first-leg swap */
  intermediateAmount?: string;
  destinationAmount?: string;
  finalAsset: string;
  slippageBps?: number;
  userDestination: string;
  agentDestination: string;
  /** Intents deposit address for cross-chain swaps */
  intentsDepositAddress?: string;
  depositMemo?: string;
  originTxHash?: string;
  sessionId?: string;
  metadata?: IntentMetadata;
  /** NEAR public key for Kamino operations (derives Solana address) */
  nearPublicKey?: string;
  /** User's address on the source chain for refunds */
  refundAddress?: string;
  /** User signature proving authorization for this intent (required for withdrawals) */
  userSignature?: UserSignature;
}

/** NEAR NEP-413 signature */
export interface NearUserSignature {
  type: "near";
  /** The signed message (typically a hash of the intent payload) */
  message: string;
  /** The signature in base64 or hex format */
  signature: string;
  /** The NEAR public key that signed (e.g., "ed25519:ABC...") */
  publicKey: string;
  /** The nonce used for NEP-413 signing (base64-encoded 32 bytes) */
  nonce: string;
  /** The recipient used for NEP-413 signing */
  recipient: string;
}

/** Solana Ed25519 signature */
export interface SolanaUserSignature {
  type: "solana";
  /** The signed message (typically a hash of the intent payload) */
  message: string;
  /** The signature in base58, base64, or hex format (64 bytes) */
  signature: string;
  /** The Solana public key that signed (base58 encoded) */
  publicKey: string;
}

/** Legacy signature format (NEAR, for backwards compatibility) */
export interface LegacyUserSignature {
  /** The signed message (typically a hash of the intent payload) */
  message: string;
  /** The signature in base64 or hex format */
  signature: string;
  /** The NEAR public key that signed (e.g., "ed25519:ABC...") */
  publicKey: string;
  /** The nonce used for NEP-413 signing (base64-encoded 32 bytes) */
  nonce: string;
  /** The recipient used for NEP-413 signing */
  recipient: string;
}

export type UserSignature = NearUserSignature | SolanaUserSignature | LegacyUserSignature;

export interface ValidatedIntent extends IntentMessage {
  slippageBps: number;
}
