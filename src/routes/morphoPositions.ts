import { Hono } from "hono";
import {
  EvmChainName,
  getEvmPublicClient,
  deriveEvmAgentAddress,
} from "../utils/evmChains";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";

const log = createLogger("morphoPositions");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

// ─── Morpho Blue Singleton ──────────────────────────────────────────────────────

const MORPHO_BLUE_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const MORPHO_SUPPORTED_CHAINS: EvmChainName[] = ["ethereum", "base"];

// ─── Known Markets (curated popular vaults) ─────────────────────────────────────

interface MorphoMarket {
  name: string;
  marketId: string;
  loanToken: string;
  loanTokenSymbol: string;
  collateralToken: string;
  collateralTokenSymbol: string;
  oracle: string;
  irm: string;
  lltv: string;
}

const MORPHO_MARKETS: Record<string, MorphoMarket[]> = {
  ethereum: [
    {
      name: "USDC/WETH (86% LLTV)",
      marketId: "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc",
      loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      loanTokenSymbol: "USDC",
      collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      collateralTokenSymbol: "WETH",
      oracle: "0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2",
      irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
      lltv: "860000000000000000",
    },
    {
      name: "USDT/WETH (86% LLTV)",
      marketId: "0xd4070ff74a4f6c2a9b62f3b4b4b1aa9fd1f1e3e4f5c6b7a8d9e0f1a2b3c4d5e6",
      loanToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      loanTokenSymbol: "USDT",
      collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      collateralTokenSymbol: "WETH",
      oracle: "0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2",
      irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
      lltv: "860000000000000000",
    },
  ],
  base: [
    {
      name: "USDC/WETH (86% LLTV)",
      marketId: "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda",
      loanToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      loanTokenSymbol: "USDC",
      collateralToken: "0x4200000000000000000000000000000000000006",
      collateralTokenSymbol: "WETH",
      oracle: "0xFc1415Af6b1623c5ef92B1682E9aa5427E8aF50C",
      irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
      lltv: "860000000000000000",
    },
  ],
};

// ─── Minimal ABI ────────────────────────────────────────────────────────────────

const MORPHO_ABI = [
  {
    name: "position",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
  },
] as const;

// ─── Routes ─────────────────────────────────────────────────────────────────────

/**
 * GET /markets
 * Returns list of known Morpho Blue markets per chain
 */
app.get("/markets", async (c) => {
  return c.json({
    markets: MORPHO_MARKETS,
    chains: MORPHO_SUPPORTED_CHAINS,
    morphoAddress: MORPHO_BLUE_ADDRESS,
  });
});

/**
 * GET /positions/:address
 * Returns Morpho Blue positions across all known markets.
 * For each market, queries the position(marketId, address) on the Morpho singleton.
 */
app.get("/positions/:address", async (c) => {
  const addressParam = c.req.param("address");
  const userDestination = c.req.query("userDestination");

  let evmAddress: string;
  if (userDestination) {
    try {
      evmAddress = await deriveEvmAgentAddress(userDestination);
    } catch (err) {
      throw new AppError(
        "operation_failed",
        `Failed to derive EVM address: ${(err as Error).message}`,
      );
    }
  } else {
    evmAddress = addressParam;
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
    throw new AppError(
      "invalid_request",
      "Invalid EVM address. Provide a valid 0x address or use ?userDestination= to derive one.",
    );
  }

  const results: Record<string, unknown[]> = {};

  for (const chain of MORPHO_SUPPORTED_CHAINS) {
    const markets = MORPHO_MARKETS[chain] || [];
    const client = getEvmPublicClient(chain);

    const positions = await Promise.all(
      markets.map(async (market) => {
        try {
          const position = await client.readContract({
            address: MORPHO_BLUE_ADDRESS as `0x${string}`,
            abi: MORPHO_ABI,
            functionName: "position",
            args: [market.marketId as `0x${string}`, evmAddress as `0x${string}`],
          });

          const supplyShares = (position[0] as bigint).toString();
          const borrowShares = (position[1] as bigint).toString();
          const collateral = (position[2] as bigint).toString();

          // Only include non-zero positions
          if (supplyShares === "0" && borrowShares === "0" && collateral === "0") {
            return null;
          }

          return {
            ...market,
            supplyShares,
            borrowShares,
            collateral,
          };
        } catch (err) {
          log.error(`Failed to query market ${market.name} on ${chain}`, { err: String(err) });
          return null;
        }
      }),
    );

    const activePositions = positions.filter((p) => p !== null);
    if (activePositions.length > 0) {
      results[chain] = activePositions;
    }
  }

  return c.json({
    address: evmAddress,
    ...(userDestination && { userDestination }),
    positions: results,
  });
});

export default app;
