// Fetch ETH price from Binance
async function getETHPriceFromBinance(): Promise<number | null> {
  try {
    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",
    );
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status}`);
    }
    const data = await response.json();
    const price = parseFloat(data.price);
    console.log(`Binance ETH Price: $${price}`);
    return price;
  } catch (error) {
    console.error("Error fetching price from Binance:", error);
    return null;
  }
}

// Fetch ETH price from Coinbase
async function getETHPriceFromCoinbase(): Promise<number | null> {
  try {
    const response = await fetch(
      "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    );
    if (!response.ok) {
      throw new Error(`Coinbase API error: ${response.status}`);
    }
    const data = await response.json();
    const price = parseFloat(data.data.amount);
    console.log(`Coinbase ETH Price: $${price}`);
    return price;
  } catch (error) {
    console.error("Error fetching price from Coinbase:", error);
    return null;
  }
}

// Fetch ETH price from Binance and Coinbase and return the average price
export async function getEthereumPriceUSD(): Promise<number | null> {
  try {
    // Fetch from both sources
    const [binancePrice, coinbasePrice] = await Promise.all([
      getETHPriceFromBinance(),
      getETHPriceFromCoinbase(),
    ]);

    // If either price is null, use the other one
    if (binancePrice === null && coinbasePrice === null) {
      throw new Error("Failed to fetch price from both sources");
    }
    if (binancePrice === null) return Math.round(coinbasePrice! * 100);
    if (coinbasePrice === null) return Math.round(binancePrice * 100);

    // Calculate average, multiply by 100 and round to integer
    const averagePrice = Math.round(((binancePrice + coinbasePrice) / 2) * 100);

    console.log(
      `Average ETH Price: $${(averagePrice / 100).toFixed(2)} (Binance: $${binancePrice}, Coinbase: $${coinbasePrice})`,
    );
    return averagePrice;
  } catch (error) {
    console.error("Error fetching Ethereum price:", error);
    return null;
  }
}
