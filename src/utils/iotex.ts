import { contracts, chainAdapters } from "chainsig.js";
import { createPublicClient, http } from "viem";

// IoTeX network configuration
export const iotexRpcUrl = "https://babel-api.testnet.iotex.io"; // Testnet
export const iotexMainnetRpcUrl = "https://babel-api.mainnet.iotex.io"; // Mainnet

// Import shared contract registry
import { getContractAddress } from './contractRegistry';

// Use shared contract addresses
export const iotexContractAddress = getContractAddress('iotex', 'testnet');
export const iotexMainnetContractAddress = getContractAddress('iotex', 'mainnet');

export const iotexContractAbi = [
  {
    inputs: [
      {
        internalType: "uint256",
        name: "_price",
        type: "uint256",
      },
    ],
    name: "updatePrice",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "getPrice",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Set up a chain signature contract instance (same as Ethereum)
const MPC_CONTRACT = new contracts.ChainSignatureContract({
  networkId: `testnet`,
  contractId: `v1.signer-prod.testnet`,
});

// Set up a public client for the IoTeX network
const iotexPublicClient = createPublicClient({
  transport: http(iotexRpcUrl),
});

// Set up a chain signatures chain adapter for the IoTeX network
export const IoTeX = new chainAdapters.evm.EVM({
  publicClient: iotexPublicClient,
  contract: MPC_CONTRACT,
}) as any;

// IoTeX mainnet adapter
const iotexMainnetPublicClient = createPublicClient({
  transport: http(iotexMainnetRpcUrl),
});

export const IoTeXMainnet = new chainAdapters.evm.EVM({
  publicClient: iotexMainnetPublicClient,
  contract: MPC_CONTRACT,
}) as any;

// Chain configuration for easy switching
export const iotexChainConfig = {
  testnet: {
    rpcUrl: iotexRpcUrl,
    contractAddress: iotexContractAddress,
    path: "iotex-1",
    chainId: 4690,
    adapter: IoTeX,
  },
  mainnet: {
    rpcUrl: iotexMainnetRpcUrl,
    contractAddress: iotexContractAddress, // Different contract address for mainnet
    path: "iotex-mainnet",
    chainId: 4689,
    adapter: IoTeXMainnet,
  },
};

// Helper function to get IoTeX adapter based on network
export function getIoTeXAdapter(network: 'testnet' | 'mainnet' = 'testnet') {
  return iotexChainConfig[network].adapter;
}

// Helper function to get IoTeX path based on network
export function getIoTeXPath(network: 'testnet' | 'mainnet' = 'testnet') {
  return iotexChainConfig[network].path;
} 