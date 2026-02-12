import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createDefaultFlowCatalog,
  createFlowContext,
  type FlowCatalog,
} from "../flows";
import {
  createIntentValidator,
  type IntentValidator,
} from "../queue/validation";
import { config } from "../config";
import type { IntentMessage, IntentChain } from "../queue/types";
import { FLOW_ACTIONS, type FlowAction } from "../types/actions";
import { createLogger } from "../utils/logger";
import { ensureIntentsApiBase } from "../infra/intentsApi";

const log = createLogger("mcp");
import { OneClickService } from "@defuse-protocol/one-click-sdk-typescript";
import { getUserPositions as getBurrowPositions, listBurrowMarkets } from "../utils/burrow";
import { deriveAgentPublicKey, SOLANA_DEFAULT_PATH } from "../utils/solana";
import { deriveNearImplicitAccount, NEAR_DEFAULT_PATH } from "../utils/chainSignature";
import { createSolanaRpc, address } from "@solana/kit";
import { KaminoMarket, PROGRAM_ID } from "@kamino-finance/klend-sdk";

// ─── Tool Schemas ───────────────────────────────────────────────────────────────

const SwapSchema = z.object({
  sourceChain: z.enum(["near", "solana", "ethereum", "base", "arbitrum"]),
  destinationChain: z.enum(["near", "solana", "ethereum", "base", "arbitrum"]),
  sourceAsset: z.string().describe("Token address or symbol on source chain"),
  destinationAsset: z.string().describe("Token address or symbol on destination chain"),
  amount: z.string().describe("Amount in smallest unit (e.g., lamports, yoctoNEAR)"),
  userAddress: z.string().describe("User's address for custody derivation"),
  slippageBps: z.number().optional().default(100).describe("Slippage tolerance in basis points (default 100 = 1%)"),
});

const LendingDepositSchema = z.object({
  protocol: z.enum(["kamino", "burrow"]),
  tokenAddress: z.string().describe("Token to deposit (contract address)"),
  amount: z.string().describe("Amount in smallest unit"),
  userAddress: z.string().describe("User's address for custody derivation"),
  // Kamino-specific
  marketAddress: z.string().optional().describe("Kamino market address (required for Kamino)"),
  // Burrow uses tokenAddress as tokenId
});

const LendingWithdrawSchema = z.object({
  protocol: z.enum(["kamino", "burrow"]),
  tokenAddress: z.string().describe("Token to withdraw (contract address)"),
  amount: z.string().describe("Amount in smallest unit"),
  userAddress: z.string().describe("User's address for custody derivation"),
  marketAddress: z.string().optional().describe("Kamino market address (required for Kamino)"),
  // Optional bridge back
  bridgeBack: z.object({
    destinationChain: z.string(),
    destinationAddress: z.string(),
    destinationAsset: z.string(),
  }).optional().describe("Bridge withdrawn funds to another chain"),
});

const GetQuoteSchema = z.object({
  sourceChain: z.enum(["near", "solana", "ethereum", "base", "arbitrum"]),
  destinationChain: z.enum(["near", "solana", "ethereum", "base", "arbitrum"]),
  sourceAsset: z.string().describe("Source asset in Defuse format (e.g., 'nep141:wrap.near', 'solana:native')"),
  destinationAsset: z.string().describe("Destination asset in Defuse format"),
  amount: z.string().describe("Amount in smallest unit"),
  slippageBps: z.number().optional().describe("Slippage tolerance in basis points (default 100 = 1%)"),
});

const GetPositionsSchema = z.object({
  protocol: z.enum(["kamino", "burrow"]),
  userAddress: z.string().describe("User's address to query positions for"),
  marketAddress: z.string().optional().describe("Specific market to query (Kamino only)"),
});

const ListFlowsSchema = z.object({});

const ListMarketsSchema = z.object({
  protocol: z.enum(["kamino", "burrow"]).describe("Which protocol to list markets for"),
});

// ─── Helper Functions ───────────────────────────────────────────────────────────

function generateIntentId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface McpServerDeps {
  flowCatalog: FlowCatalog;
  validateIntent: IntentValidator;
}

async function executeFlow(
  intentMessage: IntentMessage,
  deps: McpServerDeps,
): Promise<{ txId: string; details?: Record<string, unknown> }> {
  const intent = deps.validateIntent(intentMessage);

  const flow = deps.flowCatalog.findMatch(intent);
  if (!flow) {
    throw new Error(`No flow found for action: ${intent.metadata?.action}`);
  }

  const ctx = createFlowContext({
    intentId: intent.intentId,
    config,
    flowAction: flow.action,
    flowName: flow.name,
  });

  if (flow.validateAuthorization) {
    await flow.validateAuthorization(intent as any, ctx);
  }

  const result = await flow.execute(intent as any, ctx);

  return {
    txId: result.txId,
    details: {
      txIds: result.txIds,
      bridgeTxId: result.bridgeTxId,
      swappedAmount: result.swappedAmount,
      intentsDepositAddress: result.intentsDepositAddress,
    },
  };
}

// ─── MCP Server ─────────────────────────────────────────────────────────────────

export function createMcpServer(
  deps?: Partial<McpServerDeps>,
): McpServer {
  const flowCatalog = deps?.flowCatalog ?? createDefaultFlowCatalog();
  const validateIntent = deps?.validateIntent ?? createIntentValidator(flowCatalog);

  const server = new McpServer({
    name: "shade-agent",
    version: "1.0.0",
  });

  // ─── Tool: List Available Flows ─────────────────────────────────────────────
  server.tool(
    "list_flows",
    "List all available DeFi flows and their capabilities",
    ListFlowsSchema.shape as any,
    async () => {
      const flows = flowCatalog.getAll().map((flow) => ({
        action: flow.action,
        name: flow.name,
        description: flow.description,
        supportedChains: flow.supportedChains,
        requiredFields: flow.requiredMetadataFields,
        optionalFields: flow.optionalMetadataFields,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ flows }, null, 2),
          },
        ],
      };
    }
  );

  // ─── Tool: Cross-Chain Swap ─────────────────────────────────────────────────
  server.tool(
    "swap",
    "Execute a cross-chain token swap. Supports swaps between NEAR, Solana, Ethereum, Base, and Arbitrum.",
    SwapSchema.shape as any,
    async (params: any) => {
      const { sourceChain, destinationChain, sourceAsset, destinationAsset, amount, userAddress, slippageBps } = params;

      // Determine which swap flow to use
      let action: FlowAction;
      if (destinationChain === "solana") {
        action = FLOW_ACTIONS.SOL_SWAP;
      } else if (destinationChain === "near") {
        action = FLOW_ACTIONS.NEAR_SWAP;
      } else {
        throw new Error(`Swap to ${destinationChain} not yet supported`);
      }

      const intentMessage: IntentMessage = {
        intentId: generateIntentId(),
        sourceChain,
        destinationChain,
        sourceAsset,
        finalAsset: destinationAsset,
        sourceAmount: amount,
        userDestination: userAddress,
        agentDestination: userAddress,
        slippageBps,
        metadata: {
          action,
          tokenIn: sourceAsset,
          tokenOut: destinationAsset,
        },
      };

      try {
        const result = await executeFlow(intentMessage, {
          flowCatalog,
          validateIntent,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                txId: result.txId,
                ...result.details,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Tool: Lending Deposit ──────────────────────────────────────────────────
  server.tool(
    "lending_deposit",
    "Deposit tokens into a lending protocol. Supports Kamino (Solana) and Burrow (NEAR).",
    LendingDepositSchema.shape as any,
    async (params: any) => {
      const { protocol, tokenAddress, amount, userAddress, marketAddress } = params;

      let intentMessage: IntentMessage;

      if (protocol === "kamino") {
        if (!marketAddress) {
          throw new Error("marketAddress is required for Kamino deposits");
        }
        intentMessage = {
          intentId: generateIntentId(),
          sourceChain: "solana",
          destinationChain: "solana",
          sourceAsset: tokenAddress,
          finalAsset: tokenAddress,
          sourceAmount: amount,
          userDestination: userAddress,
          agentDestination: userAddress,
          metadata: {
            action: "kamino-deposit",
            marketAddress,
            mintAddress: tokenAddress,
          },
        };
      } else {
        // Burrow
        intentMessage = {
          intentId: generateIntentId(),
          sourceChain: "near",
          destinationChain: "near",
          sourceAsset: tokenAddress,
          finalAsset: tokenAddress,
          sourceAmount: amount,
          userDestination: userAddress,
          agentDestination: userAddress,
          metadata: {
            action: "burrow-deposit",
            tokenId: tokenAddress,
          },
        };
      }

      try {
        const result = await executeFlow(intentMessage, {
          flowCatalog,
          validateIntent,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                protocol,
                txId: result.txId,
                ...result.details,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Tool: Lending Withdraw ─────────────────────────────────────────────────
  server.tool(
    "lending_withdraw",
    "Withdraw tokens from a lending protocol. Supports Kamino (Solana) and Burrow (NEAR). Optionally bridge to another chain.",
    LendingWithdrawSchema.shape as any,
    async (params: any) => {
      const { protocol, tokenAddress, amount, userAddress, marketAddress, bridgeBack } = params;

      let intentMessage: IntentMessage;

      if (protocol === "kamino") {
        if (!marketAddress) {
          throw new Error("marketAddress is required for Kamino withdrawals");
        }
        intentMessage = {
          intentId: generateIntentId(),
          sourceChain: "solana",
          destinationChain: bridgeBack?.destinationChain as IntentChain || "solana",
          sourceAsset: tokenAddress,
          finalAsset: bridgeBack?.destinationAsset || tokenAddress,
          sourceAmount: amount,
          userDestination: userAddress,
          agentDestination: userAddress,
          metadata: {
            action: "kamino-withdraw",
            marketAddress,
            mintAddress: tokenAddress,
            bridgeBack,
          },
        };
      } else {
        // Burrow
        intentMessage = {
          intentId: generateIntentId(),
          sourceChain: "near",
          destinationChain: bridgeBack?.destinationChain as IntentChain || "near",
          sourceAsset: tokenAddress,
          finalAsset: bridgeBack?.destinationAsset || tokenAddress,
          sourceAmount: amount,
          userDestination: userAddress,
          agentDestination: userAddress,
          metadata: {
            action: "burrow-withdraw",
            tokenId: tokenAddress,
            bridgeBack,
          },
        };
      }

      try {
        const result = await executeFlow(intentMessage, {
          flowCatalog,
          validateIntent,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                protocol,
                txId: result.txId,
                ...result.details,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Tool: Get Quote ────────────────────────────────────────────────────────
  server.tool(
    "get_quote",
    "Get a quote for a cross-chain swap without executing it. Returns estimated output amount and fees.",
    GetQuoteSchema.shape as any,
    async (params: any) => {
      const { sourceChain, destinationChain, sourceAsset, destinationAsset, amount, slippageBps } = params;

      try {
        ensureIntentsApiBase();

        const quoteRequest = {
          originAsset: sourceAsset,
          destinationAsset: destinationAsset,
          amount: amount,
          swapType: "EXACT_INPUT" as const,
          slippageTolerance: slippageBps ?? 100,
          dry: true, // Don't create deposit address, just get quote
        };

        log.info("Requesting quote", quoteRequest as unknown as Record<string, unknown>);

        // `as any` justified: SDK types don't expose the full request shape
        const quoteResponse = await OneClickService.getQuote(quoteRequest as any) as Record<string, unknown>;

        const quote = (quoteResponse.quote || quoteResponse) as Record<string, unknown>;
        const amountOut = quote.amountOut || quote.minAmountOut || quote.amount;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                sourceChain,
                destinationChain,
                sourceAsset,
                destinationAsset,
                inputAmount: amount,
                estimatedOutput: amountOut,
                minOutput: quote.minAmountOut,
                slippageBps: slippageBps ?? 100,
                expiresAt: quote.expiresAt,
                priceImpact: quote.priceImpact,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
                hint: "Ensure asset IDs are in Defuse format (e.g., 'nep141:wrap.near', 'solana:native', '1cs_v1:sol:spl:EPjFWdd5...')",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Tool: Get Positions ────────────────────────────────────────────────────
  server.tool(
    "get_positions",
    "Get lending positions for a user on Kamino (Solana) or Burrow (NEAR). Returns deposits, borrows, and health metrics.",
    GetPositionsSchema.shape as any,
    async (params: any) => {
      const { protocol, userAddress, marketAddress } = params;

      try {
        if (protocol === "burrow") {
          // For Burrow, derive the NEAR implicit account from the user address
          const { accountId } = await deriveNearImplicitAccount(
            NEAR_DEFAULT_PATH,
            undefined,
            userAddress,
          );

          log.info("Fetching Burrow positions", { derivedAccountId: accountId });

          const positions = await getBurrowPositions(accountId);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  protocol: "burrow",
                  userAddress,
                  derivedAccountId: accountId,
                  positions: positions.positions,
                  totalSuppliedUsd: positions.totalSuppliedUsd,
                  totalCollateralUsd: positions.totalCollateralUsd,
                  totalBorrowedUsd: positions.totalBorrowedUsd,
                  healthFactor: positions.healthFactor,
                }, null, 2),
              },
            ],
          };
        } else {
          // Kamino - derive Solana address and query positions
          if (!marketAddress) {
            // Return available markets info
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: "marketAddress is required for Kamino positions",
                    hint: "Common Kamino markets: Main Market = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'",
                  }, null, 2),
                },
              ],
              isError: true,
            };
          }

          // Derive the Solana address from user address
          const userPublicKey = await deriveAgentPublicKey(
            SOLANA_DEFAULT_PATH,
            userAddress,
          );
          const derivedSolanaAddress = userPublicKey;

          log.info("Fetching Kamino positions", { derivedSolanaAddress });

          // Load Kamino market
          const rpc = createSolanaRpc(config.solRpcUrl);
          const market = await KaminoMarket.load(
            rpc,
            address(marketAddress),
            1000,
            PROGRAM_ID,
          );

          if (!market) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: `Market not found: ${marketAddress}`,
                  }, null, 2),
                },
              ],
              isError: true,
            };
          }

          // Get user obligations
          const obligations = await market.getAllUserObligations(address(derivedSolanaAddress));

          const formattedObligations = obligations.map((obligation) => {
            const deposits: Array<{
              reserveAddress: string;
              symbol: string;
              amount: string;
              amountUsd: string;
            }> = [];
            const borrows: Array<{
              reserveAddress: string;
              symbol: string;
              amount: string;
              amountUsd: string;
            }> = [];

            for (const [reserveAddr, position] of obligation.deposits) {
              const reserve = market.getReserveByAddress(reserveAddr);
              deposits.push({
                reserveAddress: reserveAddr,
                symbol: reserve?.symbol || "unknown",
                amount: position.amount.toString(),
                amountUsd: position.marketValueRefreshed.toString(),
              });
            }

            for (const [reserveAddr, position] of obligation.borrows) {
              const reserve = market.getReserveByAddress(reserveAddr);
              borrows.push({
                reserveAddress: reserveAddr,
                symbol: reserve?.symbol || "unknown",
                amount: position.amount.toString(),
                amountUsd: position.marketValueRefreshed.toString(),
              });
            }

            return {
              obligationAddress: obligation.obligationAddress,
              deposits,
              borrows,
              totalDepositedUsd: obligation.refreshedStats.userTotalDeposit.toString(),
              totalBorrowedUsd: obligation.refreshedStats.userTotalBorrow.toString(),
              ltv: obligation.refreshedStats.loanToValue.toString(),
              liquidationLtv: obligation.refreshedStats.liquidationLtv.toString(),
            };
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  protocol: "kamino",
                  userAddress,
                  derivedSolanaAddress,
                  marketAddress,
                  obligations: formattedObligations,
                  totalObligations: obligations.length,
                }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Tool: List Markets ──────────────────────────────────────────────────────
  server.tool(
    "list_markets",
    "List available lending markets for Kamino or Burrow. Returns market info, APYs, and liquidity.",
    ListMarketsSchema.shape as any,
    async (params: any) => {
      const { protocol } = params;

      try {
        if (protocol === "burrow") {
          log.info("Fetching Burrow markets");

          const markets = await listBurrowMarkets();

          const formattedMarkets = markets.map((m) => ({
            tokenId: m.tokenId,
            symbol: m.symbol,
            supplyApy: `${m.supplyApy.toFixed(2)}%`,
            borrowApy: `${m.borrowApy.toFixed(2)}%`,
            totalSuppliedUsd: `$${m.totalSuppliedUsd.toFixed(2)}`,
            totalBorrowedUsd: `$${m.totalBorrowedUsd.toFixed(2)}`,
            availableLiquidityUsd: `$${m.availableLiquidityUsd.toFixed(2)}`,
            canDeposit: m.canDeposit,
            canBorrow: m.canBorrow,
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  protocol: "burrow",
                  markets: formattedMarkets,
                  totalMarkets: markets.length,
                }, null, 2),
              },
            ],
          };
        } else {
          // Kamino - return known market addresses
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  protocol: "kamino",
                  markets: [
                    {
                      name: "Main Market",
                      address: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
                      description: "Primary Kamino lending market with major assets",
                    },
                    {
                      name: "JLP Market",
                      address: "DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek",
                      description: "Jupiter LP token market",
                    },
                    {
                      name: "Altcoin Market",
                      address: "ByYiZxp8QrdN9qbdtaAiePN8AAr3qvTPppNJDpf5DVJ5",
                      description: "Alternative token market",
                    },
                  ],
                  note: "Use get_positions with marketAddress to query positions in a specific market",
                }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const flowCatalog = createDefaultFlowCatalog();
  const validateIntent = createIntentValidator(flowCatalog);
  const server = createMcpServer({
    flowCatalog,
    validateIntent,
  });
  const transport = new StdioServerTransport();

  await server.connect(transport);

  log.info("Shade Agent MCP server started");
  log.info("Available tools: list_flows, swap, lending_deposit, lending_withdraw, get_quote, get_positions, list_markets");
}
