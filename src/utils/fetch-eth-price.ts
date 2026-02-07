import { fetchWithRetry } from "./http";
import { config } from "../config";
import { createLogger } from "./logger";

const log = createLogger("ethPrice");

const PRICE_FETCH_TIMEOUT_MS = 7000;

// Fetch ETH price from OKX
async function getETHPriceFromOKX(): Promise<number | null> {
  try {
    const response = await fetchWithRetry(
      "https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT",
      undefined,
      config.priceFeedMaxAttempts,
      config.priceFeedRetryBackoffMs,
      PRICE_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(`OKX API error: ${response.status}`);
    }
    const data = await response.json();
    // OKX returns an array in the 'data' field; extract the 'last' price
    const price = parseFloat(data.data[0].last);
    log.info("OKX ETH Price", { price });
    return price;
  } catch (error) {
    log.error("Error fetching price from OKX", { err: String(error) });
    return null;
  }
}

// Fetch ETH price from Coinbase
async function getETHPriceFromCoinbase(): Promise<number | null> {
  try {
    const response = await fetchWithRetry(
      "https://api.coinbase.com/v2/prices/ETH-USD/spot",
      undefined,
      config.priceFeedMaxAttempts,
      config.priceFeedRetryBackoffMs,
      PRICE_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(`Coinbase API error: ${response.status}`);
    }
    const data = await response.json();
    const price = parseFloat(data.data.amount);
    log.info("Coinbase ETH Price", { price });
    return price;
  } catch (error) {
    log.error("Error fetching price from Coinbase", { err: String(error) });
    return null;
  }
}

// Fetch ETH price from OKX and Coinbase and return the average price
export async function getEthereumPriceUSD(): Promise<number | null> {
  try {
    // Fetch from both sources
    const [okxPrice, coinbasePrice] = await Promise.all([
      getETHPriceFromOKX(),
      getETHPriceFromCoinbase(),
    ]);

    // If either price is null, use the other one
    if (okxPrice === null && coinbasePrice === null) {
      throw new Error("Failed to fetch price from both sources");
    }
    if (okxPrice === null) return Math.round(coinbasePrice! * 100);
    if (coinbasePrice === null) return Math.round(okxPrice * 100);

    // Calculate average, multiply by 100 and round to integer
    const averagePrice = Math.round(((okxPrice + coinbasePrice) / 2) * 100);

    log.info("Average ETH Price", {
      average: (averagePrice / 100).toFixed(2),
      okx: okxPrice,
      coinbase: coinbasePrice,
    });
    return averagePrice;
  } catch (error) {
    log.error("Error fetching Ethereum price", { err: String(error) });
    return null;
  }
}
