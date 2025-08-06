# Shared Contract Pattern Documentation

## Overview

Based on the analysis of the [near-multichain](https://github.com/near-examples/near-multichain) repository, this document outlines the optimal pattern for implementing multi-chain support in blockchain applications.

## Pattern Analysis

### **EVM Networks: SHARED CONTRACT PATTERN** ✅

The near-multichain example demonstrates that **shared contracts** are the optimal approach for EVM-compatible networks:

```typescript
// Centralized contract registry (from near-multichain)
export const NetworksEVM = [
  {
    network: "Ethereum",
    token: "ETH",
    rpcUrl: "https://sepolia.drpc.org",
    contractAddress: "0xFf3171733b73Cfd5A72ec28b9f2011Dc689378c6",
  },
  {
    network: "Base",
    token: "BASE",
    rpcUrl: "https://base-sepolia.drpc.org",
    contractAddress: "0x2d5B67280267309D259054BB3214f74e42c8a98c",
  },
  {
    network: "BNB Chain",
    token: "BNB",
    rpcUrl: "https://data-seed-prebsc-1-s1.binance.org:8545/",
    contractAddress: "0xf1A94B7Dfc407527722c91434c35c894287d1e52",
  },
  // ... more networks with shared contracts
];
```

### **Non-EVM Networks: DEDICATED COMPONENT PATTERN** ✅

For non-EVM networks, the pattern is to create **dedicated components**:

```
src/components/
├── Solana.jsx     (dedicated Solana logic)
├── Aptos.jsx      (dedicated Aptos logic)
├── Sui.jsx        (dedicated Sui logic)
├── XRP.jsx        (dedicated XRP logic)
└── Bitcoin.jsx    (dedicated Bitcoin logic)
```

## Benefits of Shared Contract Pattern

### ✅ **For New Developers:**
- **Zero deployment required**: Use shared contracts immediately
- **Faster onboarding**: Start testing in minutes
- **Consistent behavior**: Same contract across all instances
- **Lower costs**: No individual deployments needed

### ✅ **For Advanced Developers:**
- **Optional customization**: Deploy own contracts if needed
- **Environment variables**: Override shared contracts easily
- **Flexible configuration**: Choose between shared and custom
- **Full control**: When needed, deploy custom contracts

### ✅ **For Repository Maintainers:**
- **Centralized control**: Manage contract versions
- **Easier updates**: Deploy once, update everywhere
- **Better testing**: Consistent test environment
- **Reduced complexity**: Fewer deployment steps

## Implementation Strategy

### Phase 1: Create Contract Registry

```typescript
// src/utils/contractRegistry.ts
export const EVM_CONTRACT_REGISTRY = {
  ethereum: {
    testnet: "0xFf3171733b73Cfd5A72ec28b9f2011Dc689378c6",
    mainnet: "0x..." // Deploy when needed
  },
  base: {
    testnet: "0x2d5B67280267309D259054BB3214f74e42c8a98c",
    mainnet: "0x..."
  },
  polygon: {
    testnet: "0x03a74694bD865437eb4f83c5ed61D22000A9f502",
    mainnet: "0x..."
  },
  arbitrum: {
    testnet: "0x03a74694bD865437eb4f83c5ed61D22000A9f502",
    mainnet: "0x..."
  },
  iotex: {
    testnet: "0x...", // Deploy and add here
    mainnet: "0x..."  // Deploy and add here
  }
};

export function getContractAddress(chain: string, network: 'testnet' | 'mainnet') {
  // Check environment variable first (for custom deployments)
  const envAddress = process.env[`${chain.toUpperCase()}_CONTRACT_ADDRESS`];
  if (envAddress) return envAddress;
  
  // Fall back to shared registry
  return EVM_CONTRACT_REGISTRY[chain]?.[network] || "0x...";
}
```

### Phase 2: Update Configuration Files

```typescript
// src/utils/ethereum.ts
import { getContractAddress } from './contractRegistry';

export const ethRpcUrl = "https://sepolia.drpc.org";
export const ethContractAddress = getContractAddress('ethereum', 'testnet');
```

### Phase 3: Environment Variable Support

```bash
# .env.development.local
# Optional overrides for custom deployments
IOTEX_CONTRACT_ADDRESS=0x...
POLYGON_CONTRACT_ADDRESS=0x...
```

## Deployment Process

### Step 1: Deploy Shared Contracts

```bash
# Deploy to IoTeX testnet
npx hardhat run scripts/deploy-iotex.js --network iotexTestnet

# Deploy to IoTeX mainnet  
npx hardhat run scripts/deploy-iotex.js --network iotexMainnet
```

### Step 2: Update Registry

```typescript
// After deployment, update the registry
export const EVM_CONTRACT_REGISTRY = {
  // ... existing contracts
  iotex: {
    testnet: "0xDEPLOYED_IOTEX_TESTNET_ADDRESS",
    mainnet: "0xDEPLOYED_IOTEX_MAINNET_ADDRESS"
  }
};
```

### Step 3: Test Integration

```bash
# Test the new contract
curl -X GET "http://localhost:3000/api/iotex-account?network=testnet"
```

## Cost Analysis

### **Shared Deployment Costs:**
- **IoTeX Testnet**: ~0.1 IOTX (one-time)
- **IoTeX Mainnet**: ~1 IOTX (one-time)
- **Total**: < $10 for all chains

### **Individual Deployment Costs:**
- **Per developer**: $5-20 per chain
- **100 developers**: $500-2000 total
- **Time cost**: 30-60 minutes per developer

## Developer Experience

### **New Developer Workflow:**
1. **Clone repo** ✅
2. **Install dependencies** ✅
3. **Start testing** ✅ (No deployment needed!)

### **Custom Deployment Workflow:**
1. **Clone repo** ✅
2. **Deploy custom contracts** (Optional)
3. **Set environment variables** ✅
4. **Start testing** ✅

## Integration with near-multichain

### Current State:
- ✅ **EVM networks** use shared contracts
- ✅ **Non-EVM networks** use dedicated components
- ❌ **IoTeX** not yet implemented

### Next Steps:
1. **Deploy IoTeX contracts** (one-time task)
2. **Create IoTeX component** for near-multichain
3. **Submit PR** to near-multichain repository
4. **Test integration** with Phala deployment

## Best Practices

### **For EVM Networks:**
1. **Use shared contracts** for consistency
2. **Centralize configuration** in registry
3. **Allow environment overrides** for flexibility
4. **Document deployment process** clearly

### **For Non-EVM Networks:**
1. **Create dedicated components** for each chain
2. **Use chain-specific adapters** and logic
3. **Handle chain-specific requirements** properly
4. **Test thoroughly** before deployment

### **For Repository Maintenance:**
1. **Deploy contracts once** and share addresses
2. **Update registry** when new contracts are deployed
3. **Document changes** clearly
4. **Test all networks** regularly

## Migration Guide

### **From Individual to Shared Contracts:**

1. **Deploy shared contracts** on all target networks
2. **Create contract registry** with deployed addresses
3. **Update configuration** to use registry
4. **Test all networks** to ensure consistency
5. **Update documentation** with new pattern

### **Adding New EVM Networks:**

1. **Deploy contract** on target network
2. **Add to registry** with deployed address
3. **Update configuration** files
4. **Test integration** thoroughly
5. **Document process** for future reference

## Conclusion

The **shared contract pattern** provides the optimal balance of:
- **Developer experience** (zero setup for new users)
- **Flexibility** (environment overrides for advanced users)
- **Maintainability** (centralized control for maintainers)
- **Cost efficiency** (one deployment vs. many)

This pattern, as demonstrated by the near-multichain example, should be adopted for all EVM networks in the Shade Agent template. 