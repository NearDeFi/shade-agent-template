import { Hono } from "hono";
import {
  EvmChainName,
  getEvmPublicClient,
  deriveEvmAgentAddress,
} from "../utils/evmChains";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";

const log = createLogger("aavePositions");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

// ─── Aave V3 Pool Addresses ────────────────────────────────────────────────────

const AAVE_POOL_ADDRESSES: Record<string, string> = {
  ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
};

const AAVE_SUPPORTED_CHAINS: EvmChainName[] = ["ethereum", "base", "arbitrum"];

// ─── Known Markets (popular assets per chain) ───────────────────────────────────

interface AaveMarket {
  symbol: string;
  underlying: string;
  aToken: string;
  decimals: number;
}

const AAVE_MARKETS: Record<string, AaveMarket[]> = {
  ethereum: [
    { symbol: "USDC", underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", aToken: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c", decimals: 6 },
    { symbol: "USDT", underlying: "0xdAC17F958D2ee523a2206206994597C13D831ec7", aToken: "0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a", decimals: 6 },
    { symbol: "WETH", underlying: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", aToken: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8", decimals: 18 },
    { symbol: "DAI", underlying: "0x6B175474E89094C44Da98b954EedeAC495271d0F", aToken: "0x018008bfb33d285247A21d44E50697654f754e63", decimals: 18 },
    { symbol: "WBTC", underlying: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", aToken: "0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8", decimals: 8 },
  ],
  base: [
    { symbol: "USDC", underlying: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", aToken: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", decimals: 6 },
    { symbol: "WETH", underlying: "0x4200000000000000000000000000000000000006", aToken: "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7", decimals: 18 },
    { symbol: "cbETH", underlying: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", aToken: "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad", decimals: 18 },
  ],
  arbitrum: [
    { symbol: "USDC", underlying: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", aToken: "0x724dc807b04555b71ed48a6896b6F41593b8C637", decimals: 6 },
    { symbol: "USDT", underlying: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", aToken: "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", decimals: 6 },
    { symbol: "WETH", underlying: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", aToken: "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", decimals: 18 },
    { symbol: "WBTC", underlying: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", aToken: "0x078f358208685046a11C85e8ad32895DED33A249", decimals: 8 },
    { symbol: "DAI", underlying: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", aToken: "0x82E64f49Ed5EC1nC6e43DAD175b2488AA5BDb05", decimals: 18 },
  ],
};

// ─── Minimal ABI ────────────────────────────────────────────────────────────────

const POOL_ABI = [
  {
    name: "getUserAccountData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

const ATOKEN_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ─── Routes ─────────────────────────────────────────────────────────────────────

/**
 * GET /markets
 * Returns list of supported Aave V3 markets per chain
 */
app.get("/markets", async (c) => {
  return c.json({
    markets: AAVE_MARKETS,
    chains: AAVE_SUPPORTED_CHAINS,
    poolAddresses: AAVE_POOL_ADDRESSES,
  });
});

/**
 * GET /positions/:address
 * Returns aggregated Aave V3 position data across all supported chains.
 * The address param can be a raw EVM address or a userDestination (NEAR account ID)
 * for deriving the agent's EVM address.
 */
app.get("/positions/:address", async (c) => {
  const addressParam = c.req.param("address");
  const userDestination = c.req.query("userDestination");

  // If userDestination is provided, derive the agent EVM address
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

  // Validate EVM address format
  if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
    throw new AppError(
      "invalid_request",
      "Invalid EVM address. Provide a valid 0x address or use ?userDestination= to derive one.",
    );
  }

  const results: Record<string, unknown> = {};

  for (const chain of AAVE_SUPPORTED_CHAINS) {
    const poolAddress = AAVE_POOL_ADDRESSES[chain];
    if (!poolAddress) continue;

    try {
      const client = getEvmPublicClient(chain);
      const data = await client.readContract({
        address: poolAddress as `0x${string}`,
        abi: POOL_ABI,
        functionName: "getUserAccountData",
        args: [evmAddress as `0x${string}`],
      });

      results[chain] = {
        totalCollateralBase: (data[0] as bigint).toString(),
        totalDebtBase: (data[1] as bigint).toString(),
        availableBorrowsBase: (data[2] as bigint).toString(),
        currentLiquidationThreshold: (data[3] as bigint).toString(),
        ltv: (data[4] as bigint).toString(),
        healthFactor: (data[5] as bigint).toString(),
      };
    } catch (err) {
      log.error(`Failed to fetch data for ${chain}`, { err: String(err) });
      results[chain] = { error: (err as Error).message };
    }
  }

  return c.json({
    address: evmAddress,
    ...(userDestination && { userDestination }),
    positions: results,
  });
});

/**
 * GET /positions/:address/:chain
 * Returns detailed per-chain position including individual aToken balances.
 */
app.get("/positions/:address/:chain", async (c) => {
  const addressParam = c.req.param("address");
  const chain = c.req.param("chain") as EvmChainName;
  const userDestination = c.req.query("userDestination");

  if (!AAVE_SUPPORTED_CHAINS.includes(chain)) {
    throw new AppError(
      "invalid_request",
      `Unsupported chain: ${chain}. Supported: ${AAVE_SUPPORTED_CHAINS.join(", ")}`,
    );
  }

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
    throw new AppError("invalid_request", "Invalid EVM address");
  }

  const poolAddress = AAVE_POOL_ADDRESSES[chain];
  if (!poolAddress) {
    throw new AppError("not_found", `No Aave pool for chain ${chain}`);
  }

  try {
    const client = getEvmPublicClient(chain);

    // Get aggregate account data
    const accountData = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: POOL_ABI,
      functionName: "getUserAccountData",
      args: [evmAddress as `0x${string}`],
    });

    // Query individual aToken balances
    const markets = AAVE_MARKETS[chain] || [];
    const tokenBalances = await Promise.all(
      markets.map(async (market) => {
        try {
          const balance = await client.readContract({
            address: market.aToken as `0x${string}`,
            abi: ATOKEN_ABI,
            functionName: "balanceOf",
            args: [evmAddress as `0x${string}`],
          });
          return {
            ...market,
            balance: (balance as bigint).toString(),
          };
        } catch {
          return { ...market, balance: "0", error: "Failed to query" };
        }
      }),
    );

    return c.json({
      address: evmAddress,
      chain,
      ...(userDestination && { userDestination }),
      account: {
        totalCollateralBase: (accountData[0] as bigint).toString(),
        totalDebtBase: (accountData[1] as bigint).toString(),
        availableBorrowsBase: (accountData[2] as bigint).toString(),
        currentLiquidationThreshold: (accountData[3] as bigint).toString(),
        ltv: (accountData[4] as bigint).toString(),
        healthFactor: (accountData[5] as bigint).toString(),
      },
      tokens: tokenBalances.filter((t) => t.balance !== "0"),
    });
  } catch (err) {
    throw new AppError(
      "operation_failed",
      `Failed to fetch positions for ${chain}`,
      { cause: err },
    );
  }
});

export default app;
