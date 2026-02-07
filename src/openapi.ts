/**
 * OpenAPI specification for Shade Agent API
 */

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Shade Agent API",
    version: "1.0.0",
    description: `
Shade Agent is a verifiable cross-chain DeFi automation platform enabling trustless, self-custodial operations across Solana, NEAR, and Ethereum.

## Features
- **Cross-chain Swaps**: Swap tokens across different blockchains via Defuse Intents
- **Kamino Finance**: Deposit/withdraw from Solana lending markets
- **Burrow Protocol**: Deposit/withdraw from NEAR lending markets
- **Self-Custodial Permissions**: Pre-authorize operations with on-chain signatures
- **MPC Chain Signatures**: Secure key derivation via NEAR MPC

## Authentication
Most endpoints require either:
- **Deposit verification**: \`originTxHash\` + \`depositAddress\`
- **Signature verification**: Valid user signature (NEP-413 for NEAR, Ed25519 for Solana)
    `,
  },
  servers: [
    { url: "http://localhost:3000", description: "Local development" },
  ],
  tags: [
    { name: "Health", description: "Health check endpoints" },
    { name: "Accounts", description: "Derive wallet addresses from MPC" },
    { name: "Intents", description: "Cross-chain swap intents" },
    { name: "Orders", description: "Conditional orders (limit, stop-loss, take-profit)" },
    { name: "Permission", description: "Self-custodial operation permissions" },
    { name: "Lending", description: "Kamino & Burrow lending positions" },
    { name: "Status", description: "Intent execution status" },
    { name: "Transaction", description: "Sign and broadcast transactions" },
  ],
  paths: {
    "/": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        responses: {
          "200": {
            description: "App is running",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string", example: "App is running" },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ─── Account Routes ─────────────────────────────────────────────────────────
    "/api/agent-account": {
      get: {
        tags: ["Accounts"],
        summary: "Get agent's NEAR account",
        description: "Returns the NEAR account ID used by the agent for signing",
        responses: {
          "200": {
            description: "Agent account information",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    accountId: { type: "string", example: "agent.near" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/sol-account": {
      get: {
        tags: ["Accounts"],
        summary: "Derive Solana address",
        description: "Derive a Solana address from MPC chain signatures",
        parameters: [
          {
            name: "path",
            in: "query",
            description: "Custom derivation path (optional)",
            schema: { type: "string" },
          },
          {
            name: "userAddress",
            in: "query",
            description: "User address for custody isolation",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Derived Solana address",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    address: { type: "string", example: "5xot9PVkphiX2adznghwrAuxGs2zeWisNSxMW6hU6Hkq" },
                    derivationPath: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/eth-account": {
      get: {
        tags: ["Accounts"],
        summary: "Derive Ethereum address",
        description: "Derive an Ethereum address from MPC chain signatures",
        parameters: [
          {
            name: "path",
            in: "query",
            description: "Custom derivation path (optional)",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Derived Ethereum address",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    address: { type: "string", example: "0x1234..." },
                    derivationPath: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ─── Intents Routes ─────────────────────────────────────────────────────────
    "/api/intents": {
      post: {
        tags: ["Intents"],
        summary: "Enqueue an intent",
        description: "Submit a cross-chain swap intent for processing. Requires deposit or signature verification.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["intentId", "sourceChain", "sourceAsset", "sourceAmount", "destinationChain", "finalAsset", "userDestination"],
                properties: {
                  intentId: { type: "string", description: "Unique intent identifier" },
                  sourceChain: { type: "string", enum: ["near", "solana", "ethereum", "base", "arbitrum"] },
                  sourceAsset: { type: "string", description: "Source asset ID (Defuse format)" },
                  sourceAmount: { type: "string", description: "Amount in smallest units" },
                  destinationChain: { type: "string", enum: ["near", "solana", "ethereum", "base", "arbitrum"] },
                  finalAsset: { type: "string", description: "Destination asset ID" },
                  userDestination: { type: "string", description: "User's destination address" },
                  slippageBps: { type: "number", description: "Slippage tolerance in basis points" },
                  originTxHash: { type: "string", description: "Deposit transaction hash (for verification)" },
                  intentsDepositAddress: { type: "string", description: "Deposit address from quote" },
                  userSignature: {
                    type: "object",
                    description: "User signature for authorization",
                    properties: {
                      message: { type: "string" },
                      signature: { type: "string" },
                      publicKey: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "Intent accepted and queued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    intentId: { type: "string" },
                    state: { type: "string", example: "pending" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid request body" },
          "403": { description: "Missing or invalid verification" },
          "503": { description: "Queue disabled" },
        },
      },
    },
    "/api/intents/quote": {
      post: {
        tags: ["Intents"],
        summary: "Get a swap quote",
        description: "Get a quote for a cross-chain swap. Set dry: false to get deposit address and auto-enqueue.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["originAsset", "destinationAsset", "amount"],
                properties: {
                  originAsset: { type: "string", description: "Source asset ID", example: "1cs_v1:sol:native" },
                  destinationAsset: { type: "string", description: "Destination asset ID", example: "1cs_v1:sol:spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
                  amount: { type: "string", description: "Amount in smallest units" },
                  slippageTolerance: { type: "number", description: "Slippage in basis points", default: 300 },
                  dry: { type: "boolean", description: "If true, preview only. If false, get deposit address.", default: true },
                  sourceChain: { type: "string", description: "Required when dry: false" },
                  userDestination: { type: "string", description: "Required when dry: false" },
                  kaminoDeposit: {
                    type: "object",
                    description: "For Kamino deposits",
                    properties: {
                      marketAddress: { type: "string" },
                      mintAddress: { type: "string" },
                    },
                  },
                  burrowDeposit: {
                    type: "object",
                    description: "For Burrow deposits",
                    properties: {
                      tokenId: { type: "string" },
                      isCollateral: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Quote response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    timestamp: { type: "string" },
                    quote: {
                      type: "object",
                      properties: {
                        quoteId: { type: "string" },
                        amountOut: { type: "string" },
                        minAmountOut: { type: "string" },
                        depositAddress: { type: "string" },
                        depositMemo: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ─── Orders Routes ─────────────────────────────────────────────────────────
    "/api/orders": {
      get: {
        tags: ["Orders"],
        summary: "List user orders",
        description: "Get all orders for a user address",
        parameters: [
          { name: "userAddress", in: "query", required: true, schema: { type: "string" }, description: "User's wallet address" },
          { name: "state", in: "query", schema: { type: "string", enum: ["pending", "active", "triggered", "executed", "cancelled", "expired", "failed"] }, description: "Filter by order state" },
          { name: "limit", in: "query", schema: { type: "integer", default: 50 }, description: "Maximum results" },
        ],
        responses: {
          "200": {
            description: "User orders",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    count: { type: "integer" },
                    orders: { type: "array", items: { $ref: "#/components/schemas/Order" } },
                  },
                },
              },
            },
          },
          "400": { description: "userAddress is required" },
        },
      },
      post: {
        tags: ["Orders"],
        summary: "Create conditional order",
        description: "Create a limit, stop-loss, or take-profit order. Returns custody address for funding.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["orderId", "orderType", "side", "priceAsset", "quoteAsset", "triggerPrice", "priceCondition", "sourceChain", "sourceAsset", "amount", "destinationChain", "targetAsset", "userDestination"],
                properties: {
                  orderId: { type: "string", minLength: 8, description: "Unique order ID (min 8 chars)" },
                  orderType: { type: "string", enum: ["limit", "stop-loss", "take-profit"], description: "Order type" },
                  side: { type: "string", enum: ["buy", "sell"], description: "Buy or sell" },
                  priceAsset: { type: "string", description: "Asset to monitor price (e.g., SOL)", example: "SOL" },
                  quoteAsset: { type: "string", description: "Quote currency (e.g., USDC)", example: "USDC" },
                  triggerPrice: { type: "string", description: "Price trigger point", example: "150.00" },
                  priceCondition: { type: "string", enum: ["above", "below"], description: "Trigger when price goes above or below" },
                  sourceChain: { type: "string", enum: ["solana", "near"], description: "Custody chain (Solana or NEAR)" },
                  sourceAsset: { type: "string", description: "Asset to swap from" },
                  amount: { type: "string", description: "Amount in smallest units" },
                  destinationChain: { type: "string", enum: ["solana", "near", "ethereum", "base", "arbitrum"], description: "Output chain" },
                  targetAsset: { type: "string", description: "Asset to receive" },
                  userDestination: { type: "string", description: "User's wallet address" },
                  expiresAt: { type: "integer", description: "Expiry timestamp (ms)" },
                  slippageTolerance: { type: "integer", description: "Slippage in basis points", default: 300 },
                  userSignature: { $ref: "#/components/schemas/UserSignature" },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "Order creation queued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    intentId: { type: "string" },
                    orderId: { type: "string" },
                    state: { type: "string", example: "pending" },
                    custodyAddress: { type: "string", description: "Deposit funds here to activate" },
                    custodyChain: { type: "string", enum: ["solana", "near"] },
                    message: { type: "string" },
                    order: {
                      type: "object",
                      properties: {
                        orderType: { type: "string" },
                        side: { type: "string" },
                        priceAsset: { type: "string" },
                        quoteAsset: { type: "string" },
                        triggerPrice: { type: "string" },
                        priceCondition: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid request" },
          "503": { description: "Queue disabled" },
        },
      },
    },
    "/api/orders/{orderId}": {
      get: {
        tags: ["Orders"],
        summary: "Get order details",
        parameters: [
          { name: "orderId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Order details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Order" },
              },
            },
          },
          "404": { description: "Order not found" },
        },
      },
    },
    "/api/orders/{orderId}/cancel": {
      post: {
        tags: ["Orders"],
        summary: "Cancel order",
        description: "Cancel an active order and optionally refund funds. Requires signature.",
        parameters: [
          { name: "orderId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["userDestination", "userSignature"],
                properties: {
                  userDestination: { type: "string", description: "Owner's wallet address" },
                  refundFunds: { type: "boolean", default: true, description: "Refund remaining funds" },
                  userSignature: { $ref: "#/components/schemas/UserSignature" },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "Cancellation queued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    intentId: { type: "string" },
                    orderId: { type: "string" },
                    state: { type: "string" },
                    message: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { description: "Cannot cancel executed order" },
          "403": { description: "Not order owner or invalid signature" },
          "404": { description: "Order not found" },
        },
      },
    },
    "/api/orders/{orderId}/fund": {
      post: {
        tags: ["Orders"],
        summary: "Mark order as funded",
        description:
          "Activate a pending order after deposit is detected. This endpoint is for internal deposit-monitor use and requires an order funding key.",
        parameters: [
          { name: "orderId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "x-order-funding-key",
            in: "header",
            required: false,
            schema: { type: "string" },
            description:
              "Funding API key. Alternative: Authorization Bearer token with the same value.",
          },
          {
            name: "Authorization",
            in: "header",
            required: false,
            schema: { type: "string", example: "Bearer <ORDER_FUNDING_API_KEY>" },
            description: "Bearer token alternative to x-order-funding-key.",
          },
        ],
        responses: {
          "200": {
            description: "Order activated (or already in a non-pending state)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    order: { $ref: "#/components/schemas/Order" },
                  },
                },
              },
            },
          },
          "401": { description: "Missing or invalid funding key" },
          "503": { description: "Manual funding endpoint disabled (ORDER_FUNDING_API_KEY unset)" },
          "404": { description: "Order not found" },
        },
      },
    },
    "/api/orders/status/poller": {
      get: {
        tags: ["Orders"],
        summary: "Get order poller status",
        description: "Get status of the price monitoring poller",
        responses: {
          "200": {
            description: "Poller status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    activePairs: { type: "integer" },
                    activeOrders: { type: "integer" },
                    pairs: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          pair: { type: "string", example: "SOL:USDC" },
                          orderCount: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/orders/status/check": {
      post: {
        tags: ["Orders"],
        summary: "Manually check orders",
        description: "Trigger a manual price check for all active orders (for testing)",
        responses: {
          "200": {
            description: "Check result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    checked: { type: "integer" },
                    triggered: { type: "integer" },
                  },
                },
              },
            },
          },
          "503": { description: "Queue disabled" },
        },
      },
    },

    // ─── Permission Routes ──────────────────────────────────────────────────────
    "/api/permission/contract": {
      get: {
        tags: ["Permission"],
        summary: "Get permission contract ID",
        responses: {
          "200": {
            description: "Contract ID",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    contractId: { type: "string", example: "permission-shade.testnet" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/permission/active": {
      get: {
        tags: ["Permission"],
        summary: "Get active operations",
        description: "Get all active (non-executed) operations for TEE polling",
        parameters: [
          { name: "from", in: "query", schema: { type: "integer", default: 0 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
        ],
        responses: {
          "200": {
            description: "Active operations",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    operations: { type: "array", items: { $ref: "#/components/schemas/AllowedOperation" } },
                    count: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/permission/{derivationPath}": {
      get: {
        tags: ["Permission"],
        summary: "Get permissions for derivation path",
        parameters: [
          { name: "derivationPath", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "User permissions",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UserPermissions" },
              },
            },
          },
          "404": { description: "No permissions found" },
        },
      },
    },
    "/api/permission/register": {
      post: {
        tags: ["Permission"],
        summary: "Register a wallet",
        description: "Register a wallet for a derivation path with signature verification",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["derivationPath", "walletType", "publicKey", "chainAddress", "signature", "message", "nonce"],
                properties: {
                  derivationPath: { type: "string", description: "MPC derivation path" },
                  walletType: { type: "string", enum: ["near", "solana", "evm"] },
                  publicKey: { type: "string", description: "Hex or base58 encoded public key" },
                  chainAddress: { type: "string", description: "Wallet address on the chain" },
                  signature: { type: "string", description: "Hex encoded signature" },
                  message: { type: "string", description: "Signed message" },
                  nonce: { type: "integer", description: "Nonce for replay protection" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Wallet registered",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    txHash: { type: "string" },
                    derivationPath: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { description: "Missing required fields" },
          "401": { description: "Invalid signature" },
        },
      },
    },
    "/api/permission/operation": {
      post: {
        tags: ["Permission"],
        summary: "Add allowed operation",
        description: "Pre-authorize an operation (limit order, stop-loss, take-profit, swap)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["derivationPath", "operationType", "sourceAsset", "targetAsset", "maxAmount", "destinationAddress", "destinationChain", "signature", "message"],
                properties: {
                  derivationPath: { type: "string" },
                  operationType: { type: "string", enum: ["limit-order", "stop-loss", "take-profit", "swap"] },
                  sourceAsset: { type: "string" },
                  targetAsset: { type: "string" },
                  maxAmount: { type: "string" },
                  destinationAddress: { type: "string" },
                  destinationChain: { type: "string" },
                  slippageBps: { type: "integer", default: 100 },
                  priceAsset: { type: "string", description: "Required for conditional orders" },
                  quoteAsset: { type: "string", description: "Required for conditional orders" },
                  triggerPrice: { type: "string", description: "Required for conditional orders" },
                  condition: { type: "string", enum: ["above", "below"] },
                  signature: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Operation added",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    txHash: { type: "string" },
                    operationId: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Permission"],
        summary: "Remove allowed operation",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["derivationPath", "operationId", "signature", "message"],
                properties: {
                  derivationPath: { type: "string" },
                  operationId: { type: "string" },
                  signature: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Operation removed" },
        },
      },
    },

    // ─── Lending Routes ─────────────────────────────────────────────────────────
    "/api/kamino-positions": {
      get: {
        tags: ["Lending"],
        summary: "Get Kamino positions",
        description: "Get Kamino lending positions for a wallet",
        parameters: [
          { name: "wallet", in: "query", required: true, schema: { type: "string" }, description: "Solana wallet address" },
        ],
        responses: {
          "200": {
            description: "Kamino positions",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    positions: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/burrow-positions": {
      get: {
        tags: ["Lending"],
        summary: "Get Burrow positions",
        description: "Get Burrow lending positions for a NEAR account",
        parameters: [
          { name: "account", in: "query", required: true, schema: { type: "string" }, description: "NEAR account ID" },
        ],
        responses: {
          "200": {
            description: "Burrow positions",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    supplied: { type: "array", items: { type: "object" } },
                    borrowed: { type: "array", items: { type: "object" } },
                    collateral: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ─── Status Routes ──────────────────────────────────────────────────────────
    "/api/status/{intentId}": {
      get: {
        tags: ["Status"],
        summary: "Get intent status",
        parameters: [
          { name: "intentId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Intent status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    state: { type: "string", enum: ["pending", "processing", "succeeded", "failed"] },
                    txHash: { type: "string" },
                    error: { type: "string" },
                    updatedAt: { type: "string" },
                  },
                },
              },
            },
          },
          "404": { description: "Intent not found" },
        },
      },
    },

    // ─── Transaction Routes ─────────────────────────────────────────────────────
    "/api/transaction/sign": {
      post: {
        tags: ["Transaction"],
        summary: "Sign an EVM transaction",
        description: "Sign an Ethereum transaction using MPC chain signatures",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["to", "value", "chainId"],
                properties: {
                  to: { type: "string", description: "Recipient address" },
                  value: { type: "string", description: "Value in wei" },
                  data: { type: "string", description: "Transaction data (hex)" },
                  chainId: { type: "integer", description: "EVM chain ID" },
                  gasLimit: { type: "string" },
                  maxFeePerGas: { type: "string" },
                  maxPriorityFeePerGas: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Signed transaction",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    signedTransaction: { type: "string" },
                    txHash: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Order: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          state: { type: "string", enum: ["pending", "active", "triggered", "executed", "cancelled", "expired", "failed"] },
          orderType: { type: "string", enum: ["limit", "stop-loss", "take-profit"] },
          side: { type: "string", enum: ["buy", "sell"] },
          priceAsset: { type: "string" },
          quoteAsset: { type: "string" },
          triggerPrice: { type: "string" },
          priceCondition: { type: "string", enum: ["above", "below"] },
          sourceChain: { type: "string" },
          sourceAsset: { type: "string" },
          amount: { type: "string" },
          destinationChain: { type: "string" },
          targetAsset: { type: "string" },
          userAddress: { type: "string" },
          agentAddress: { type: "string", description: "Custody address" },
          agentChain: { type: "string" },
          slippageTolerance: { type: "integer" },
          expiresAt: { type: "integer", nullable: true },
          createdAt: { type: "integer" },
          fundedAt: { type: "integer", nullable: true },
          triggeredAt: { type: "integer", nullable: true },
          executedAt: { type: "integer", nullable: true },
          triggeredPrice: { type: "string", nullable: true },
          executionTxId: { type: "string", nullable: true },
          outputAmount: { type: "string", nullable: true },
          error: { type: "string", nullable: true },
          description: { type: "string", description: "Human-readable order description" },
        },
      },
      UserSignature: {
        type: "object",
        description: "User signature for authorization (NEAR NEP-413 or Solana Ed25519)",
        properties: {
          type: { type: "string", enum: ["near", "solana"], description: "Signature type" },
          message: { type: "string", description: "Signed message" },
          signature: { type: "string", description: "Signature bytes (base64 or hex)" },
          publicKey: { type: "string", description: "Signer's public key" },
          nonce: { type: "string", description: "NEP-413 nonce (NEAR only)" },
          recipient: { type: "string", description: "NEP-413 recipient (NEAR only)" },
        },
        required: ["message", "signature", "publicKey"],
      },
      AllowedOperation: {
        type: "object",
        properties: {
          operation_id: { type: "string" },
          derivation_path: { type: "string" },
          operation_type: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["Swap", "LimitOrder", "StopLoss", "TakeProfit"] },
              source_asset: { type: "string" },
              target_asset: { type: "string" },
              max_amount: { type: "string" },
              trigger_price: { type: "string" },
              condition: { type: "string", enum: ["Above", "Below"] },
            },
          },
          destination_address: { type: "string" },
          destination_chain: { type: "string" },
          slippage_bps: { type: "integer" },
          expires_at: { type: "integer", nullable: true },
          executed: { type: "boolean" },
          nonce: { type: "integer" },
          created_at: { type: "integer" },
        },
      },
      UserPermissions: {
        type: "object",
        properties: {
          owner_wallets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                wallet_type: { type: "string", enum: ["Near", "Solana", "Evm"] },
                public_key: { type: "array", items: { type: "integer" } },
                chain_address: { type: "string" },
              },
            },
          },
          operations: {
            type: "array",
            items: { $ref: "#/components/schemas/AllowedOperation" },
          },
          next_nonce: { type: "integer" },
        },
      },
    },
  },
};
