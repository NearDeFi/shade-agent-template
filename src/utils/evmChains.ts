// @ts-nocheck
import { contracts, chainAdapters, utils } from "chainsig.js";
import { createPublicClient, http, PublicClient, encodeFunctionData, erc20Abi } from "viem";
import { mainnet, base, arbitrum, bsc } from "viem/chains";
import { requestSignature } from "@neardefi/shade-agent-js";
import { config } from "../config";
import { ETH_NATIVE_TOKEN } from "../constants";

const { toRSV, uint8ArrayToHex } = utils.cryptography;

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvmChainName = "ethereum" | "base" | "arbitrum" | "bnb";

export interface EvmChainConfig {
  chainId: number;
  rpcUrl: string;
  /** 0x Swap API base URL */
  zeroExBaseUrl: string;
  /** Address of the wrapped native token (e.g., WETH, WBNB) */
  wrappedNativeToken: string;
  /** Defuse asset ID for the native token (e.g., "nep141:eth.omft.near") */
  nativeDefuseAssetId: string;
  /** viem chain definition */
  viemChain: typeof mainnet;
}

// ─── Static Config ────────────────────────────────────────────────────────────

export const EVM_CHAIN_CONFIGS: Record<EvmChainName, EvmChainConfig> = {
  ethereum: {
    chainId: 1,
    rpcUrl: config.ethRpcUrl,
    zeroExBaseUrl: "https://api.0x.org",
    wrappedNativeToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    nativeDefuseAssetId: "nep141:eth.omft.near",
    viemChain: mainnet,
  },
  base: {
    chainId: 8453,
    rpcUrl: config.baseRpcUrl,
    zeroExBaseUrl: "https://base.api.0x.org",
    wrappedNativeToken: "0x4200000000000000000000000000000000000006",
    nativeDefuseAssetId: "nep141:base.omft.near",
    viemChain: base,
  },
  arbitrum: {
    chainId: 42161,
    rpcUrl: config.arbRpcUrl,
    zeroExBaseUrl: "https://arbitrum.api.0x.org",
    wrappedNativeToken: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    nativeDefuseAssetId: "nep141:arb.omft.near",
    viemChain: arbitrum,
  },
  bnb: {
    chainId: 56,
    rpcUrl: config.bnbRpcUrl,
    zeroExBaseUrl: "https://bsc.api.0x.org",
    wrappedNativeToken: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    nativeDefuseAssetId: "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
    viemChain: bsc,
  },
};

export const EVM_SWAP_CHAINS: EvmChainName[] = ["ethereum", "base", "arbitrum", "bnb"];

// ─── Shared MPC Contract ──────────────────────────────────────────────────────

const MPC_CONTRACT = new contracts.ChainSignatureContract({
  networkId: config.chainSignatureNetwork as "mainnet" | "testnet",
  contractId: config.chainSignatureContractId,
  masterPublicKey: config.chainSignatureMpcKey,
  fallbackRpcUrls: config.nearRpcUrls,
} as any);

// ─── Adapter Cache ────────────────────────────────────────────────────────────

const adapterCache = new Map<EvmChainName, any>();
const publicClientCache = new Map<EvmChainName, PublicClient>();

/**
 * Returns a cached EVM chain adapter (chainsig.js) for the given chain.
 */
export function getEvmAdapter(chain: EvmChainName) {
  let adapter = adapterCache.get(chain);
  if (adapter) return adapter;

  const cfg = EVM_CHAIN_CONFIGS[chain];
  if (!cfg) throw new Error(`Unknown EVM chain: ${chain}`);

  const publicClient = createPublicClient({
    chain: cfg.viemChain,
    transport: http(cfg.rpcUrl),
  });
  publicClientCache.set(chain, publicClient as PublicClient);

  adapter = new chainAdapters.evm.EVM({
    publicClient,
    contract: MPC_CONTRACT,
  });
  adapterCache.set(chain, adapter);
  return adapter;
}

/**
 * Returns the cached viem PublicClient for a given EVM chain.
 */
export function getEvmPublicClient(chain: EvmChainName): PublicClient {
  // Ensure adapter (and therefore client) is created
  getEvmAdapter(chain);
  return publicClientCache.get(chain)!;
}

// ─── Address Derivation ───────────────────────────────────────────────────────

/**
 * Derives the agent's EVM address for a given user destination.
 * Uses a custody-isolated derivation path: "ethereum-1,<userDestination>"
 * The same address is produced on all EVM chains (same secp256k1 key).
 */
export async function deriveEvmAgentAddress(userDestination: string): Promise<string> {
  const adapter = getEvmAdapter("ethereum"); // any chain works, same MPC key
  const contractId = config.shadeContractId;
  if (!contractId) throw new Error("NEXT_PUBLIC_contractId not configured");

  const path = `ethereum-1,${userDestination}`;
  const { address } = await adapter.deriveAddressAndPublicKey(contractId, path);
  return address as string;
}

// ─── Sign & Broadcast ─────────────────────────────────────────────────────────

/**
 * Prepares, signs (via MPC), and broadcasts an EVM transaction.
 * Mirrors the pattern in src/routes/transaction.ts:37-51.
 */
export async function signAndBroadcastEvmTx(
  chain: EvmChainName,
  txRequest: { from: string; to: string; data?: string; value?: string },
  userDestination: string,
): Promise<string> {
  const adapter = getEvmAdapter(chain);
  const path = `ethereum-1,${userDestination}`;

  const { transaction, hashesToSign } = await adapter.prepareTransactionForSigning(txRequest);

  const signRes = await requestSignature({
    path,
    payload: uint8ArrayToHex(hashesToSign[0]),
    keyType: "Ecdsa",
  });

  const signedTransaction = adapter.finalizeTransactionSigning({
    transaction,
    rsvSignatures: [toRSV(signRes)],
  });

  const txResult = await adapter.broadcastTx(signedTransaction);
  return txResult.hash as string;
}

// ─── Balance Helpers ──────────────────────────────────────────────────────────

/**
 * Returns the native token balance (ETH, BNB, etc.) for an address on the given chain.
 */
export async function getEvmNativeBalance(chain: EvmChainName, address: string): Promise<bigint> {
  const client = getEvmPublicClient(chain);
  return client.getBalance({ address: address as `0x${string}` });
}

/**
 * Returns the ERC-20 token balance for an address on the given chain.
 */
export async function getEvmTokenBalance(
  chain: EvmChainName,
  token: string,
  owner: string,
): Promise<bigint> {
  const client = getEvmPublicClient(chain);
  return client.readContract({
    address: token as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner as `0x${string}`],
  }) as Promise<bigint>;
}

/**
 * Returns the ERC-20 allowance for a spender on the given chain.
 */
export async function getEvmTokenAllowance(
  chain: EvmChainName,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const client = getEvmPublicClient(chain);
  return client.readContract({
    address: token as `0x${string}`,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner as `0x${string}`, spender as `0x${string}`],
  }) as Promise<bigint>;
}

// ─── Chain Detection ──────────────────────────────────────────────────────────

/**
 * Detects which EVM chain a Defuse asset ID belongs to.
 * Returns undefined if the asset is not on a supported EVM chain.
 */
export function detectEvmChainFromAsset(assetId: string): EvmChainName | undefined {
  if (!assetId) return undefined;

  // 1cs_v1:<chain>:erc20:... or 1cs_v1:<chain>:bep20:...
  const oneClickMatch = assetId.match(/^1cs_v1:(\w+):/);
  if (oneClickMatch) {
    const chainPrefix = oneClickMatch[1].toLowerCase();
    return mapChainPrefix(chainPrefix);
  }

  // nep245:v2_1.omni.hot.tg:<chainId>_... (HOT Omni bridge, used for BNB Chain / Polygon / etc.)
  const hotOmniMatch = assetId.match(/^nep245:v2_1\.omni\.hot\.tg:(\d+)_/);
  if (hotOmniMatch) {
    return mapChainId(parseInt(hotOmniMatch[1], 10));
  }

  // nep141:<chain>.omft.near or nep141:<chain>-0x....omft.near
  const nep141Match = assetId.match(/^nep141:(\w+)(?:-|\.)/);
  if (nep141Match) {
    const chainPrefix = nep141Match[1].toLowerCase();
    return mapChainPrefix(chainPrefix);
  }

  return undefined;
}

function mapChainPrefix(prefix: string): EvmChainName | undefined {
  switch (prefix) {
    case "eth":
    case "ethereum":
      return "ethereum";
    case "base":
      return "base";
    case "arb":
    case "arbitrum":
      return "arbitrum";
    case "bnb":
    case "bsc":
      return "bnb";
    default:
      return undefined;
  }
}

function mapChainId(chainId: number): EvmChainName | undefined {
  switch (chainId) {
    case 1:
      return "ethereum";
    case 8453:
      return "base";
    case 42161:
      return "arbitrum";
    case 56:
      return "bnb";
    default:
      return undefined;
  }
}

// ─── Startup Warning ──────────────────────────────────────────────────────────

if (!config.zeroExApiKey) {
  console.warn("[evmChains] ZERO_EX_API_KEY is not set; EVM swap quotes will fail");
}
