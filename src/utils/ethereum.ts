// @ts-nocheck
import { contracts, chainAdapters } from "chainsig.js";
import { createPublicClient, http } from "viem";
import { config } from "../config";

export const ethRpcUrl = config.ethRpcUrl;
export const ethContractAddress = config.ethContractAddress;

export const ethContractAbi = [
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

// Set up a chain signature contract instance
const MPC_CONTRACT = new contracts.ChainSignatureContract({
  networkId: config.chainSignatureNetwork as "mainnet" | "testnet",
  contractId: config.chainSignatureContractId,
  masterPublicKey: config.chainSignatureMpcKey,
  fallbackRpcUrls: config.nearRpcUrls,
} as any);

// Set up a public client for the Ethereum network
const publicClient = createPublicClient({
  transport: http(ethRpcUrl),
});

// Set up a chain signatures chain adapter for the Ethereum network
export const Evm = new chainAdapters.evm.EVM({
  publicClient,
  contract: MPC_CONTRACT,
}) as any;
