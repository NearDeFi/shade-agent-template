import { isTestnet } from "../config";
import { nearViewCall, getFtMetadata, FtMetadata } from "./nearRpc";
import { createLogger } from "./logger";

const log = createLogger("burrow");

// Burrow contract addresses
export const BURROW_CONTRACT = isTestnet
  ? "contract.main.burrow.testnet"
  : "contract.main.burrow.near";

export const WRAP_NEAR_CONTRACT = isTestnet
  ? "wrap.testnet"
  : "wrap.near";

// Burrow asset configuration from contract
export interface BurrowAssetConfig {
  reserve_ratio: number;
  prot_ratio: number;
  target_utilization: number;
  target_utilization_rate: string;
  max_utilization_rate: string;
  holding_position_fee_rate: string;
  volatility_ratio: number;
  extra_decimals: number;
  can_deposit: boolean;
  can_withdraw: boolean;
  can_use_as_collateral: boolean;
  can_borrow: boolean;
  net_tvl_multiplier: number;
  max_change_rate: string | null;
  supplied_limit: string | null;
  borrowed_limit: string | null;
}

export interface BurrowAssetDetailed {
  token_id: string;
  supplied: {
    shares: string;
    balance: string;
  };
  borrowed: {
    shares: string;
    balance: string;
  };
  reserved: string;
  prot_fee: string;
  last_update_timestamp: string;
  config: BurrowAssetConfig;
  supply_apr: string;
  borrow_apr: string;
  farms: BurrowFarm[];
  // Additional fields from Rhea SDK
  beneficiary_fees?: Record<string, string>;
  margin_debt?: {
    balance: string;
    shares: string;
  };
  margin_pending_debt?: string;
  margin_position?: string;
  lostfound_shares?: string;
  uahpi?: string;
}

export interface BurrowFarmReward {
  reward_per_day: string;
  booster_log_bases?: Record<string, string>;
  remaining_rewards: string;
  boosted_shares: string;
}

export interface BurrowFarm {
  farm_id: { Supplied?: string; Borrowed?: string; TokenNetBalance?: string };
  rewards: Record<string, BurrowFarmReward>;
}

export interface BurrowAccountSupplied {
  token_id: string;
  balance: string;
  shares: string;
  apr: string;
}

export interface BurrowAccountBorrowed {
  token_id: string;
  balance: string;
  shares: string;
  apr: string;
}

export interface BurrowAccountCollateral {
  token_id: string;
  balance: string;
  shares: string;
  apr: string;
}

export interface BurrowAccountFarm {
  farm_id: { Supplied?: string; Borrowed?: string; NetTvl?: string };
  rewards: Array<{
    reward_token_id: string;
    boosted_shares: string;
    unclaimed_amount: string;
    asset_farm_reward: {
      reward_per_day: string;
      booster_log_base: string;
      remaining_rewards: string;
      boosted_shares: string;
    };
  }>;
}

export interface BurrowAccount {
  account_id: string;
  supplied: BurrowAccountSupplied[];
  collateral: BurrowAccountCollateral[];
  borrowed: BurrowAccountBorrowed[];
  farms: BurrowAccountFarm[];
  has_non_farmed_assets: boolean;
  booster_staking: {
    staked_booster_amount: string;
    unlock_timestamp: string;
    x_booster_amount: string;
  } | null;
}

export interface BurrowPriceData {
  timestamp: string;
  recency_duration_sec: number;
  prices: Array<{
    asset_id: string;
    price: {
      multiplier: string;
      decimals: number;
    } | null;
  }>;
}

// Rhea Finance SDK base URL
const RHEA_SDK_BASE_URL = "https://lendingsdk.rhea.finance";

interface RheaSdkResponse {
  code: string;
  data: BurrowAssetDetailed[];
  msg: string;
}

// Fetch market data from Rhea Finance SDK
export async function getAssetsPagedDetailed(): Promise<BurrowAssetDetailed[]> {
  const response = await fetch(`${RHEA_SDK_BASE_URL}/get_assets_paged_detailed`);

  if (!response.ok) {
    throw new Error(`Failed to fetch Burrow markets from Rhea SDK: ${response.status}`);
  }

  const result: RheaSdkResponse = await response.json();

  if (result.code !== "0" || result.msg !== "success") {
    throw new Error(`Rhea SDK error: ${result.msg}`);
  }

  return result.data;
}

interface RheaAccountResponse {
  code: string;
  msg: string;
  data: BurrowAccount | null;
}

export async function getBurrowAccount(accountId: string): Promise<BurrowAccount | null> {
  try {
    const response = await fetch(`${RHEA_SDK_BASE_URL}/get_account/${accountId}`);

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch account: ${response.status}`);
    }

    const result: RheaAccountResponse = await response.json();

    if (result.code !== "0") {
      return null;
    }

    return result.data;
  } catch (err) {
    log.warn(`getBurrowAccount failed for ${accountId}`, { err: String(err) });
    return null;
  }
}

export async function getPriceData(): Promise<BurrowPriceData> {
  // Price oracle contract
  const priceOracleContract = isTestnet
    ? "priceoracle.testnet"
    : "priceoracle.near";

  return nearViewCall<BurrowPriceData>(
    priceOracleContract,
    "get_price_data",
    {},
  );
}

// Convert APR (decimal) to APY (decimal) with daily compounding
function aprToApy(apr: number): number {
  return Math.pow(1 + apr / 365, 365) - 1;
}

// Helper to calculate token price from oracle data
export function calculateTokenPrice(
  priceData: BurrowPriceData,
  tokenId: string,
  tokenDecimals: number,
): number {
  const priceInfo = priceData.prices.find((p) => p.asset_id === tokenId);
  if (!priceInfo?.price) return 0;

  const multiplier = parseInt(priceInfo.price.multiplier, 10);
  const priceDecimals = priceInfo.price.decimals;

  // Price = multiplier / 10^(priceDecimals - tokenDecimals)
  return multiplier / Math.pow(10, priceDecimals - tokenDecimals);
}

// Formatted market data for UI
export interface BurrowMarket {
  tokenId: string;
  symbol: string;
  decimals: number;
  price: number;
  supplyApy: number;
  borrowApy: number;
  totalSupplied: string;
  totalSuppliedUsd: number;
  totalBorrowed: string;
  totalBorrowedUsd: number;
  availableLiquidity: string;
  availableLiquidityUsd: number;
  canDeposit: boolean;
  canWithdraw: boolean;
  canBorrow: boolean;
  canUseAsCollateral: boolean;
  volatilityRatio: number;
  extraDecimals: number;
}

export async function listBurrowMarkets(): Promise<BurrowMarket[]> {
  const [assets, priceData] = await Promise.all([
    getAssetsPagedDetailed(),
    getPriceData(),
  ]);

  const markets: BurrowMarket[] = [];

  for (const asset of assets) {
    try {
      const metadata = await getFtMetadata(asset.token_id);
      const tokenDecimals = metadata.decimals;
      const extraDecimals = asset.config.extra_decimals;
      const totalDecimals = tokenDecimals + extraDecimals;

      const price = calculateTokenPrice(priceData, asset.token_id, tokenDecimals);

      const totalSupplied = BigInt(asset.supplied.balance) + BigInt(asset.reserved) + BigInt(asset.prot_fee);
      const totalBorrowed = BigInt(asset.borrowed.balance);
      const availableLiquidity = totalSupplied - totalBorrowed;

      const divisor = Math.pow(10, totalDecimals);
      const totalSuppliedNum = Number(totalSupplied) / divisor;
      const totalBorrowedNum = Number(totalBorrowed) / divisor;
      const availableLiquidityNum = Number(availableLiquidity) / divisor;

      markets.push({
        tokenId: asset.token_id,
        symbol: metadata.symbol,
        decimals: tokenDecimals,
        price,
        supplyApy: aprToApy(parseFloat(asset.supply_apr)) * 100,
        borrowApy: aprToApy(parseFloat(asset.borrow_apr)) * 100,
        totalSupplied: totalSupplied.toString(),
        totalSuppliedUsd: totalSuppliedNum * price,
        totalBorrowed: totalBorrowed.toString(),
        totalBorrowedUsd: totalBorrowedNum * price,
        availableLiquidity: availableLiquidity.toString(),
        availableLiquidityUsd: availableLiquidityNum * price,
        canDeposit: asset.config.can_deposit,
        canWithdraw: asset.config.can_withdraw,
        canBorrow: asset.config.can_borrow,
        canUseAsCollateral: asset.config.can_use_as_collateral,
        volatilityRatio: asset.config.volatility_ratio,
        extraDecimals,
      });
    } catch (err) {
      log.warn(`Failed to fetch metadata for ${asset.token_id}`, { err: String(err) });
    }
  }

  return markets;
}

// User position data
export interface BurrowPosition {
  tokenId: string;
  symbol: string;
  decimals: number;
  suppliedBalance: string;
  suppliedBalanceUsd: number;
  collateralBalance: string;
  collateralBalanceUsd: number;
  borrowedBalance: string;
  borrowedBalanceUsd: number;
}

export interface BurrowUserPositions {
  accountId: string;
  positions: BurrowPosition[];
  totalSuppliedUsd: number;
  totalCollateralUsd: number;
  totalBorrowedUsd: number;
  healthFactor: number | null;
}

export async function getUserPositions(accountId: string): Promise<BurrowUserPositions> {
  const [account, assets, priceData] = await Promise.all([
    getBurrowAccount(accountId),
    getAssetsPagedDetailed(),
    getPriceData(),
  ]);

  if (!account) {
    return {
      accountId,
      positions: [],
      totalSuppliedUsd: 0,
      totalCollateralUsd: 0,
      totalBorrowedUsd: 0,
      healthFactor: null,
    };
  }

  const tokenMetadataCache: Record<string, FtMetadata> = {};
  const assetConfigMap: Record<string, BurrowAssetConfig> = {};

  for (const asset of assets) {
    assetConfigMap[asset.token_id] = asset.config;
  }

  const positions: BurrowPosition[] = [];
  let totalSuppliedUsd = 0;
  let totalCollateralUsd = 0;
  let totalBorrowedUsd = 0;
  let adjustedCollateralUsd = 0;
  let adjustedBorrowedUsd = 0;

  // Process all unique tokens
  const allTokenIds = new Set([
    ...account.supplied.map((s) => s.token_id),
    ...account.collateral.map((c) => c.token_id),
    ...account.borrowed.map((b) => b.token_id),
  ]);

  for (const tokenId of allTokenIds) {
    try {
      if (!tokenMetadataCache[tokenId]) {
        tokenMetadataCache[tokenId] = await getFtMetadata(tokenId);
      }
      const metadata = tokenMetadataCache[tokenId];
      const config = assetConfigMap[tokenId];
      const extraDecimals = config?.extra_decimals || 0;
      const totalDecimals = metadata.decimals + extraDecimals;
      const divisor = Math.pow(10, totalDecimals);
      const volatilityRatio = (config?.volatility_ratio || 0) / 10000;

      const price = calculateTokenPrice(priceData, tokenId, metadata.decimals);

      const supplied = account.supplied.find((s) => s.token_id === tokenId);
      const collateral = account.collateral.find((c) => c.token_id === tokenId);
      const borrowed = account.borrowed.find((b) => b.token_id === tokenId);

      const suppliedBalance = supplied?.balance || "0";
      const collateralBalance = collateral?.balance || "0";
      const borrowedBalance = borrowed?.balance || "0";

      const suppliedNum = Number(BigInt(suppliedBalance)) / divisor;
      const collateralNum = Number(BigInt(collateralBalance)) / divisor;
      const borrowedNum = Number(BigInt(borrowedBalance)) / divisor;

      const suppliedUsd = suppliedNum * price;
      const collateralUsd = collateralNum * price;
      const borrowedUsd = borrowedNum * price;

      totalSuppliedUsd += suppliedUsd;
      totalCollateralUsd += collateralUsd;
      totalBorrowedUsd += borrowedUsd;

      // For health factor calculation
      adjustedCollateralUsd += collateralUsd * volatilityRatio;
      if (volatilityRatio > 0) {
        adjustedBorrowedUsd += borrowedUsd / volatilityRatio;
      }

      positions.push({
        tokenId,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        suppliedBalance,
        suppliedBalanceUsd: suppliedUsd,
        collateralBalance,
        collateralBalanceUsd: collateralUsd,
        borrowedBalance,
        borrowedBalanceUsd: borrowedUsd,
      });
    } catch (err) {
      log.warn(`Failed to process position for ${tokenId}`, { err: String(err) });
    }
  }

  // Health factor = adjusted collateral / adjusted borrowed
  const healthFactor = adjustedBorrowedUsd > 0
    ? (adjustedCollateralUsd / adjustedBorrowedUsd) * 100
    : null;

  return {
    accountId,
    positions,
    totalSuppliedUsd,
    totalCollateralUsd,
    totalBorrowedUsd,
    healthFactor,
  };
}

// Get extra decimals for a token from Burrow config
export async function getExtraDecimals(tokenId: string): Promise<number> {
  const assets = await getAssetsPagedDetailed();
  const asset = assets.find((a) => a.token_id === tokenId);
  return asset?.config.extra_decimals || 0;
}

export interface RheaSupplyRequest {
  token_id: string;
  amount: string;
  is_collateral: boolean;
}

export interface RheaSupplyResponse {
  code: string;
  msg: string;
  data: {
    amount: number;
    args: {
      amount: string;
      msg: string;
      receiver_id: string;
    };
    contract_id: string;
    method_name: string;
  };
}

export async function buildSupplyTransaction(
  request: RheaSupplyRequest,
): Promise<RheaSupplyResponse["data"]> {
  const response = await fetch(`${RHEA_SDK_BASE_URL}/supply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to build supply transaction: ${response.status}`);
  }

  const result: RheaSupplyResponse = await response.json();

  if (result.code !== "0" || result.msg !== "success") {
    throw new Error(`Rhea SDK supply error: ${result.msg}`);
  }

  return result.data;
}

export interface RheaWithdrawRequest {
  token_id: string;
  amount: string;
}

export interface RheaWithdrawResponse {
  code: string;
  msg: string;
  data: {
    amount: number;
    args: {
      actions: Array<{
        Withdraw?: {
          token_id: string;
          max_amount: string;
        };
        DecreaseCollateral?: {
          token_id: string;
          max_amount: string;
        };
      }>;
    };
    contract_id: string;
    method_name: string;
  };
}

export async function buildWithdrawTransaction(
  request: RheaWithdrawRequest,
): Promise<RheaWithdrawResponse["data"]> {
  const response = await fetch(`${RHEA_SDK_BASE_URL}/withdraw`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to build withdraw transaction: ${response.status}`);
  }

  const result: RheaWithdrawResponse = await response.json();

  if (result.code !== "0" || result.msg !== "success") {
    throw new Error(`Rhea SDK withdraw error: ${result.msg}`);
  }

  return result.data;
}
