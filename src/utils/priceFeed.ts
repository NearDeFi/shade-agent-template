/**
 * Price feed utility for fetching token prices from various sources.
 * Used by conditional orders (limit, stop-loss, take-profit) to check trigger conditions.
 */

import { fetchWithRetry } from "./http";
import { config } from "../config";
import { createLogger } from "./logger";

const log = createLogger("priceFeed");

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface PriceData {
  price: number;
  timestamp: number;
  source: string;
}

export interface PricePair {
  baseAsset: string;
  quoteAsset: string;
}

// ─── Price Cache ────────────────────────────────────────────────────────────────

interface CachedPrice extends PriceData {
  expiresAt: number;
}

const priceCache = new Map<string, CachedPrice>();
const CACHE_TTL_MS = 10_000; // 10 seconds

function getCacheKey(baseAsset: string, quoteAsset: string): string {
  return `${baseAsset}:${quoteAsset}`;
}

function getCachedPrice(baseAsset: string, quoteAsset: string): PriceData | null {
  const key = getCacheKey(baseAsset, quoteAsset);
  const cached = priceCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      price: cached.price,
      timestamp: cached.timestamp,
      source: cached.source,
    };
  }

  return null;
}

function setCachedPrice(baseAsset: string, quoteAsset: string, data: PriceData): void {
  const key = getCacheKey(baseAsset, quoteAsset);
  priceCache.set(key, {
    ...data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ─── Jupiter Price API (Solana) ─────────────────────────────────────────────────

const JUPITER_PRICE_API = "https://price.jup.ag/v6/price";

// Common Solana token addresses
const SOLANA_TOKEN_ADDRESSES: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
};

/**
 * Get price from Jupiter Price API
 */
async function getJupiterPrice(
  baseAsset: string,
  quoteAsset: string,
): Promise<PriceData | null> {
  try {
    // Resolve token addresses
    const baseAddress = SOLANA_TOKEN_ADDRESSES[baseAsset.toUpperCase()] || baseAsset;
    const quoteAddress = SOLANA_TOKEN_ADDRESSES[quoteAsset.toUpperCase()] || quoteAsset;

    const url = `${JUPITER_PRICE_API}?ids=${baseAddress}&vsToken=${quoteAddress}`;

    const response = await fetchWithRetry(url, undefined, 2, 1000);
    if (!response.ok) {
      log.warn("Jupiter API error", { status: response.status });
      return null;
    }

    const data = await response.json();
    const priceInfo = data.data?.[baseAddress];

    if (!priceInfo?.price) {
      log.warn("No Jupiter price", { baseAsset, quoteAsset });
      return null;
    }

    return {
      price: priceInfo.price,
      timestamp: Date.now(),
      source: "jupiter",
    };
  } catch (error) {
    log.error("Jupiter price fetch error", { err: String(error) });
    return null;
  }
}

// ─── CoinGecko API (Fallback) ───────────────────────────────────────────────────

const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price";

// CoinGecko IDs for common tokens
const COINGECKO_IDS: Record<string, string> = {
  SOL: "solana",
  NEAR: "near",
  ETH: "ethereum",
  BTC: "bitcoin",
  USDC: "usd-coin",
  USDT: "tether",
  BONK: "bonk",
  JUP: "jupiter-exchange-solana",
};

const COINGECKO_QUOTE_CURRENCIES: Record<string, string> = {
  USDC: "usd",
  USDT: "usd",
  USD: "usd",
  ETH: "eth",
  BTC: "btc",
};

/**
 * Get price from CoinGecko API
 */
async function getCoinGeckoPrice(
  baseAsset: string,
  quoteAsset: string,
): Promise<PriceData | null> {
  try {
    const coinId = COINGECKO_IDS[baseAsset.toUpperCase()];
    const vsCurrency = COINGECKO_QUOTE_CURRENCIES[quoteAsset.toUpperCase()] || "usd";

    if (!coinId) {
      log.warn("No CoinGecko ID", { baseAsset });
      return null;
    }

    const url = `${COINGECKO_API}?ids=${coinId}&vs_currencies=${vsCurrency}`;

    const response = await fetchWithRetry(url, undefined, 2, 1000);
    if (!response.ok) {
      log.warn("CoinGecko API error", { status: response.status });
      return null;
    }

    const data = await response.json();
    const price = data[coinId]?.[vsCurrency];

    if (price === undefined) {
      log.warn("No CoinGecko price", { baseAsset, quoteAsset });
      return null;
    }

    return {
      price,
      timestamp: Date.now(),
      source: "coingecko",
    };
  } catch (error) {
    log.error("CoinGecko price fetch error", { err: String(error) });
    return null;
  }
}

// ─── Pyth Network (On-Chain Oracle) ─────────────────────────────────────────────

// Pyth price feed IDs for common pairs
const PYTH_FEED_IDS: Record<string, string> = {
  "SOL/USD": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "ETH/USD": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "BTC/USD": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "NEAR/USD": "0xc415de8d2efa7bbeb725f407ff9b724f4b87c6cd9b9e8b8e4b1e4e5b3e8c8b1a",
};

// ─── Main Price Fetcher ─────────────────────────────────────────────────────────

/**
 * Get current price for a token pair.
 * Tries multiple sources in order: cache -> Jupiter -> CoinGecko
 */
export async function getPrice(
  baseAsset: string,
  quoteAsset: string,
): Promise<PriceData> {
  // Check cache first
  const cached = getCachedPrice(baseAsset, quoteAsset);
  if (cached) {
    return cached;
  }

  // Try Jupiter first (best for Solana tokens)
  let priceData = await getJupiterPrice(baseAsset, quoteAsset);

  // Fall back to CoinGecko
  if (!priceData) {
    priceData = await getCoinGeckoPrice(baseAsset, quoteAsset);
  }

  if (!priceData) {
    throw new Error(`Unable to fetch price for ${baseAsset}/${quoteAsset}`);
  }

  // Cache the result
  setCachedPrice(baseAsset, quoteAsset, priceData);

  return priceData;
}

/**
 * Get prices for multiple pairs in batch
 */
export async function getPrices(
  pairs: PricePair[],
): Promise<Map<string, PriceData>> {
  const results = new Map<string, PriceData>();

  // Fetch in parallel
  const promises = pairs.map(async ({ baseAsset, quoteAsset }) => {
    try {
      const price = await getPrice(baseAsset, quoteAsset);
      results.set(getCacheKey(baseAsset, quoteAsset), price);
    } catch (error) {
      log.error("Failed to get price", { baseAsset, quoteAsset, err: String(error) });
    }
  });

  await Promise.all(promises);

  return results;
}

/**
 * Check if a price condition is met
 */
export function checkPriceCondition(
  currentPrice: number,
  triggerPrice: number,
  condition: "above" | "below",
): boolean {
  if (condition === "above") {
    return currentPrice >= triggerPrice;
  } else {
    return currentPrice <= triggerPrice;
  }
}

/**
 * Parse a price string to number (handles decimals)
 */
export function parsePrice(priceStr: string): number {
  const price = parseFloat(priceStr);
  if (isNaN(price) || price < 0) {
    throw new Error(`Invalid price: ${priceStr}`);
  }
  return price;
}

/**
 * Format a price for display
 */
export function formatPrice(price: number, decimals: number = 6): string {
  return price.toFixed(decimals);
}
