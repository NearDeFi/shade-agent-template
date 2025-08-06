// Contract Registry for Shared Contract Pattern
// Based on near-multichain example: https://github.com/near-examples/near-multichain

export const EVM_CONTRACT_REGISTRY = {
  ethereum: {
    testnet: "0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8", // Sepolia
    mainnet: "0x..." // Deploy when needed
  },
  base: {
    testnet: "0x2d5B67280267309D259054BB3214f74e42c8a98c", // From near-multichain
    mainnet: "0x..."
  },
  polygon: {
    testnet: "0x03a74694bD865437eb4f83c5ed61D22000A9f502", // From near-multichain
    mainnet: "0x..."
  },
  arbitrum: {
    testnet: "0x03a74694bD865437eb4f83c5ed61D22000A9f502", // From near-multichain
    mainnet: "0x..."
  },
  bnb: {
    testnet: "0xf1A94B7Dfc407527722c91434c35c894287d1e52", // From near-multichain
    mainnet: "0x..."
  },
  avalanche: {
    testnet: "0x03a74694bD865437eb4f83c5ed61D22000A9f502", // From near-multichain
    mainnet: "0x..."
  },
  iotex: {
    testnet: "0x...", // Deploy and add here
    mainnet: "0x..."  // Deploy and add here
  }
};

/**
 * Get contract address for a specific chain and network
 * @param chain - The blockchain chain (e.g., 'ethereum', 'polygon', 'iotex')
 * @param network - The network type ('testnet' or 'mainnet')
 * @returns The contract address for the specified chain and network
 */
export function getContractAddress(chain: string, network: 'testnet' | 'mainnet'): string {
  // Check environment variable first (for custom deployments)
  const envAddress = process.env[`${chain.toUpperCase()}_CONTRACT_ADDRESS`];
  if (envAddress) {
    console.log(`Using custom contract address for ${chain}: ${envAddress}`);
    return envAddress;
  }
  
  // Fall back to shared registry
  const address = EVM_CONTRACT_REGISTRY[chain]?.[network];
  if (address && address !== "0x...") {
    return address;
  }
  
  // Return placeholder if not found or not deployed
  console.warn(`No contract address found for ${chain} ${network}. Please deploy a contract and update the registry.`);
  return "0x...";
}

/**
 * Check if a contract is deployed for a specific chain and network
 * @param chain - The blockchain chain
 * @param network - The network type
 * @returns True if contract is deployed, false otherwise
 */
export function isContractDeployed(chain: string, network: 'testnet' | 'mainnet'): boolean {
  const address = getContractAddress(chain, network);
  return address !== "0x..." && address.length === 42; // Valid Ethereum address length
}

/**
 * Get all deployed contracts for a specific network
 * @param network - The network type
 * @returns Object with chain names as keys and contract addresses as values
 */
export function getDeployedContracts(network: 'testnet' | 'mainnet'): Record<string, string> {
  const deployed: Record<string, string> = {};
  
  Object.entries(EVM_CONTRACT_REGISTRY).forEach(([chain, networks]) => {
    const address = networks[network];
    if (address && address !== "0x...") {
      deployed[chain] = address;
    }
  });
  
  return deployed;
}

/**
 * Get list of chains that need contract deployment
 * @param network - The network type
 * @returns Array of chain names that need deployment
 */
export function getChainsNeedingDeployment(network: 'testnet' | 'mainnet'): string[] {
  const needsDeployment: string[] = [];
  
  Object.entries(EVM_CONTRACT_REGISTRY).forEach(([chain, networks]) => {
    const address = networks[network];
    if (!address || address === "0x...") {
      needsDeployment.push(chain);
    }
  });
  
  return needsDeployment;
}

/**
 * Update contract address in registry
 * @param chain - The blockchain chain
 * @param network - The network type
 * @param address - The new contract address
 */
export function updateContractAddress(chain: string, network: 'testnet' | 'mainnet', address: string): void {
  if (EVM_CONTRACT_REGISTRY[chain]) {
    EVM_CONTRACT_REGISTRY[chain][network] = address;
    console.log(`Updated ${chain} ${network} contract address to: ${address}`);
  } else {
    console.error(`Chain ${chain} not found in registry`);
  }
}

/**
 * Validate contract address format
 * @param address - The contract address to validate
 * @returns True if valid Ethereum address format, false otherwise
 */
export function isValidContractAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Get contract registry status
 * @returns Object with deployment status for all chains
 */
export function getRegistryStatus(): Record<string, { testnet: boolean; mainnet: boolean }> {
  const status: Record<string, { testnet: boolean; mainnet: boolean }> = {};
  
  Object.entries(EVM_CONTRACT_REGISTRY).forEach(([chain, networks]) => {
    status[chain] = {
      testnet: isContractDeployed(chain, 'testnet'),
      mainnet: isContractDeployed(chain, 'mainnet')
    };
  });
  
  return status;
} 