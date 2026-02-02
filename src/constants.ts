export const SOL_NATIVE_MINT = "So11111111111111111111111111111111111111112";

/** 0x Swap API sentinel address for native ETH/BNB */
export const ETH_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// NEAR wrapped token contract (used as intermediate asset for NEAR-based intents)
export const WRAP_NEAR_CONTRACT = "wrap.near";

/**
 * Extracts the Solana mint address from various asset ID formats.
 * Supports:
 * - 1cs_v1:sol:spl:<mintAddress> (1-Click SDK format for SPL tokens)
 * - 1cs_v1:sol:spl:<mintAddress>:<decimals> (1-Click SDK format with decimals)
 * - sol:<mintAddress> (simple chain prefix format)
 * - Raw mint addresses (44-character base58 strings)
 *
 * @param assetId The asset ID in any supported format
 * @returns The raw Solana mint address, or the original string if no pattern matches
 */
export function extractSolanaMintAddress(assetId: string): string {
  if (!assetId) return assetId;

  // 1cs_v1:sol:spl:<mintAddress> or 1cs_v1:sol:spl:<mintAddress>:<decimals>
  if (assetId.startsWith("1cs_v1:sol:spl:")) {
    const parts = assetId.split(":");
    // parts[0] = "1cs_v1", parts[1] = "sol", parts[2] = "spl", parts[3] = mintAddress, parts[4]? = decimals
    if (parts.length >= 4 && parts[3]) {
      return parts[3];
    }
  }

  // sol:<mintAddress> format
  if (assetId.startsWith("sol:")) {
    return assetId.slice(4);
  }

  // Already a raw mint address (44-character base58)
  // Solana addresses are 32-44 characters in base58
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(assetId)) {
    return assetId;
  }

  // Return as-is for unrecognized formats
  return assetId;
}

/**
 * Extracts the EVM token address from various asset ID formats.
 * Supports:
 * - 1cs_v1:eth:erc20:0xAddress (1-Click SDK format for ERC-20 tokens)
 * - 1cs_v1:eth:erc20:0xAddress:decimals (with decimals suffix)
 * - 1cs_v1:base:erc20:0xAddress (Base chain)
 * - 1cs_v1:arb:erc20:0xAddress (Arbitrum chain)
 * - 1cs_v1:bnb:bep20:0xAddress (BNB Chain)
 * - nep141:eth-0xAddress.omft.near (NEAR wrapped ERC-20)
 * - nep141:eth.omft.near / nep141:base.omft.near / etc (native token)
 * - nep141:aurora-0xAddress.omft.near (Aurora/ETH)
 * - nep245:v2_1.omni.hot.tg:<chainId>_11111111111111111111 (HOT Omni native, e.g., BNB)
 * - nep245:v2_1.omni.hot.tg:<chainId>_<base58addr> (HOT Omni ERC-20/BEP-20 — returns native sentinel since on-chain address is not directly decodable)
 * - Raw 0x addresses
 *
 * @param assetId The asset ID in any supported format
 * @returns The raw EVM token address (0x...) or ETH_NATIVE_TOKEN for native
 */
export function extractEvmTokenAddress(assetId: string): string {
  if (!assetId) return assetId;

  // 1cs_v1:<chain>:erc20:0xAddress or 1cs_v1:<chain>:bep20:0xAddress
  const oneClickMatch = assetId.match(/^1cs_v1:\w+:(?:erc20|bep20):(0x[0-9a-fA-F]{40})/);
  if (oneClickMatch) {
    return oneClickMatch[1];
  }

  // nep245:v2_1.omni.hot.tg:<chainId>_11111111111111111111 → native token (HOT Omni bridge)
  if (/^nep245:v2_1\.omni\.hot\.tg:\d+_1{20}$/.test(assetId)) {
    return ETH_NATIVE_TOKEN;
  }

  // nep245:v2_1.omni.hot.tg:<chainId>_<base58addr> → non-native HOT Omni token
  // The base58 address can't be directly decoded to 0x address here;
  // the flow will need to resolve it via the token mappings or 0x API
  // For now, return the native sentinel — the flow handles token resolution
  if (/^nep245:v2_1\.omni\.hot\.tg:\d+_.+$/.test(assetId)) {
    // Non-native HOT Omni token — return the raw assetId; caller must resolve
    return assetId;
  }

  // nep141:<chain>.omft.near → native token
  if (/^nep141:(?:eth|base|arb|bnb|aurora)\.omft\.near$/.test(assetId)) {
    return ETH_NATIVE_TOKEN;
  }

  // nep141:<chain>-0xAddress.omft.near → ERC-20
  const nep141Match = assetId.match(/^nep141:(?:eth|base|arb|bnb|aurora)-(0x[0-9a-fA-F]{40})\.omft\.near$/);
  if (nep141Match) {
    return nep141Match[1];
  }

  // Raw 0x address
  if (/^0x[0-9a-fA-F]{40}$/.test(assetId)) {
    return assetId;
  }

  // Return as-is for unrecognized formats
  return assetId;
}
