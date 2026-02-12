import { Hono } from "hono";
import { createSolanaRpc, address } from "@solana/kit";
import { KaminoMarket, PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { config } from "../config";
import { deriveAgentPublicKey, SOLANA_DEFAULT_PATH } from "../utils/solana";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";

const log = createLogger("kaminoPositions");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

function createKaminoRpc() {
  return createSolanaRpc(config.solRpcUrl);
}

interface PositionInfo {
  reserveAddress: string;
  mintAddress: string;
  symbol: string;
  depositedAmount: string;
  depositedAmountUsd: string;
  borrowedAmount: string;
  borrowedAmountUsd: string;
}

interface KaminoPositionsResponse {
  userAddress: string;
  marketAddress: string;
  obligations: {
    obligationAddress: string;
    deposits: PositionInfo[];
    borrows: PositionInfo[];
    totalDepositedUsd: string;
    totalBorrowedUsd: string;
    ltv: string;
    liquidationLtv: string;
  }[];
}

app.get("/:marketAddress", async (c) => {
  const marketAddress = c.req.param("marketAddress");
  const userDestination = c.req.query("userDestination");

  if (!marketAddress) {
    throw new AppError("invalid_request", "marketAddress is required");
  }

  if (!userDestination) {
    throw new AppError("invalid_request", "userDestination is required");
  }

  try {
    // Derive the user's Solana address using the same path as deposits
    // userDestination is the NEAR account ID (e.g., "user.near")
    const userAddress = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      userDestination,
    );

    const rpc = createKaminoRpc();

    // Load the Kamino market
    const market = await KaminoMarket.load(
      rpc,
      address(marketAddress),
      1000,
      PROGRAM_ID,
    );

    if (!market) {
      throw new AppError("not_found", `Market not found: ${marketAddress}`);
    }

    // Get all user obligations in this market
    const obligations = await market.getAllUserObligations(address(userAddress));

    const response: KaminoPositionsResponse = {
      userAddress,
      marketAddress,
      obligations: obligations.map((obligation) => {
        const deposits: PositionInfo[] = [];
        const borrows: PositionInfo[] = [];

        // Process deposits
        for (const [reserveAddr, position] of obligation.deposits) {
          const reserve = market.getReserveByAddress(reserveAddr);
          deposits.push({
            reserveAddress: reserveAddr,
            mintAddress: reserve?.getLiquidityMint() || "unknown",
            symbol: reserve?.symbol || "unknown",
            depositedAmount: position.amount.toString(),
            depositedAmountUsd: position.marketValueRefreshed.toString(),
            borrowedAmount: "0",
            borrowedAmountUsd: "0",
          });
        }

        // Process borrows
        for (const [reserveAddr, position] of obligation.borrows) {
          const reserve = market.getReserveByAddress(reserveAddr);
          borrows.push({
            reserveAddress: reserveAddr,
            mintAddress: reserve?.getLiquidityMint() || "unknown",
            symbol: reserve?.symbol || "unknown",
            depositedAmount: "0",
            depositedAmountUsd: "0",
            borrowedAmount: position.amount.toString(),
            borrowedAmountUsd: position.marketValueRefreshed.toString(),
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
      }),
    };

    return c.json(response);
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError("operation_failed", (err as Error).message, { cause: err });
  }
});

// Get positions across all known markets
app.get("/", async (c) => {
  const userDestination = c.req.query("userDestination");

  if (!userDestination) {
    throw new AppError("invalid_request", "userDestination is required");
  }

  try {
    // Derive the user's Solana address using the same path as deposits
    // userDestination is the NEAR account ID (e.g., "user.near")
    log.info(`Root route - deriving address for userDestination: ${userDestination}`);
    log.info(`Root route - derivation path: ${SOLANA_DEFAULT_PATH},${userDestination}`);

    const userAddress = await deriveAgentPublicKey(
      SOLANA_DEFAULT_PATH,
      userDestination,
    );
    log.info(`Root route - derived Solana address: ${userAddress}`);

    // Return the derived address and instructions
    return c.json({
      userAddress,
      message:
        "Use GET /:marketAddress?userDestination=... to query positions in a specific market",
      example: `/api/kamino-positions/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF?userDestination=${userDestination}`,
    });
  } catch (err) {
    throw new AppError("operation_failed", (err as Error).message, { cause: err });
  }
});

export default app;
