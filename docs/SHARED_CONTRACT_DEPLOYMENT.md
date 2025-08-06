# Shared Contract Deployment Strategy

## Problem Statement

Currently, every developer using this repo needs to deploy their own smart contracts on each supported chain, which is:
- **Repetitive**: Same deployment process for every developer
- **Error-prone**: Different contract versions and addresses
- **Time-consuming**: Setup and deployment for each chain
- **Inconsistent**: Different gas costs and deployment parameters

## Solution: Shared Contract Deployment

### Phase 1: Centralized Deployment

**Goal**: Deploy contracts once and share addresses with all developers

#### Chains to Deploy:
1. **Sepolia** ✅ (Already deployed: `0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8`)
2. **IoTeX Testnet** ❌ (Needs deployment)
3. **IoTeX Mainnet** ❌ (Needs deployment)
4. **Polygon Mumbai** ❌ (Future)
5. **Arbitrum Sepolia** ❌ (Future)

### Phase 2: Contract Address Registry

Create a centralized registry of deployed contracts:

```typescript
// src/utils/contractRegistry.ts
export const CONTRACT_REGISTRY = {
  sepolia: {
    testnet: "0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8",
    mainnet: "TBD"
  },
  iotex: {
    testnet: "0x...", // Deploy and add here
    mainnet: "0x..."  // Deploy and add here
  },
  polygon: {
    testnet: "0x...", // Future
    mainnet: "0x..."  // Future
  }
};
```

### Phase 3: Environment-Based Configuration

Allow developers to override shared contracts:

```typescript
// src/utils/contractConfig.ts
export function getContractAddress(chain: string, network: 'testnet' | 'mainnet') {
  // Check environment variable first (for custom deployments)
  const envAddress = process.env[`${chain.toUpperCase()}_CONTRACT_ADDRESS`];
  if (envAddress) return envAddress;
  
  // Fall back to shared registry
  return CONTRACT_REGISTRY[chain]?.[network] || "0x...";
}
```

## Deployment Process

### Step 1: Deploy IoTeX Contracts

```bash
# Deploy to IoTeX testnet
npx hardhat run scripts/deploy-iotex.js --network iotexTestnet

# Deploy to IoTeX mainnet  
npx hardhat run scripts/deploy-iotex.js --network iotexMainnet
```

### Step 2: Update Registry

```typescript
// After deployment, update the registry
export const CONTRACT_REGISTRY = {
  sepolia: {
    testnet: "0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8",
    mainnet: "TBD"
  },
  iotex: {
    testnet: "0xDEPLOYED_IOTEX_TESTNET_ADDRESS",
    mainnet: "0xDEPLOYED_IOTEX_MAINNET_ADDRESS"
  }
};
```

### Step 3: Update Configuration Files

```typescript
// src/utils/iotex.ts
import { getContractAddress } from './contractConfig';

export const iotexContractAddress = getContractAddress('iotex', 'testnet');
export const iotexMainnetContractAddress = getContractAddress('iotex', 'mainnet');
```

## Benefits for Developers

### ✅ **For New Developers:**
- **Zero deployment required**: Use shared contracts immediately
- **Faster onboarding**: Start testing in minutes
- **Consistent behavior**: Same contract across all instances

### ✅ **For Advanced Developers:**
- **Optional customization**: Deploy own contracts if needed
- **Environment variables**: Override shared contracts easily
- **Flexible configuration**: Choose between shared and custom

### ✅ **For Repository Maintainers:**
- **Centralized control**: Manage contract versions
- **Easier updates**: Deploy once, update everywhere
- **Better testing**: Consistent test environment

## Implementation Steps

### 1. Deploy IoTeX Contracts (One-time)
```bash
# Follow deploy-iotex-contract.md
# Deploy to both testnet and mainnet
# Record contract addresses
```

### 2. Create Contract Registry
```typescript
// src/utils/contractRegistry.ts
export const CONTRACT_REGISTRY = {
  // Add deployed addresses here
};
```

### 3. Update Configuration
```typescript
// src/utils/iotex.ts
// Use registry instead of hardcoded addresses
```

### 4. Add Environment Support
```bash
# .env.development.local
IOTEX_CONTRACT_ADDRESS=0x... # Optional override
```

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

## Cost Analysis

### **Shared Deployment Costs:**
- **IoTeX Testnet**: ~0.1 IOTX (one-time)
- **IoTeX Mainnet**: ~1 IOTX (one-time)
- **Total**: < $10 for all chains

### **Individual Deployment Costs:**
- **Per developer**: $5-20 per chain
- **100 developers**: $500-2000 total
- **Time cost**: 30-60 minutes per developer

## Recommendation

**Implement shared contract deployment** because:

1. **Reduces friction** for new developers
2. **Saves time and money** for the community
3. **Ensures consistency** across all deployments
4. **Maintains flexibility** for advanced users
5. **Scales better** as more chains are added

## Next Steps

1. **Deploy IoTeX contracts** (one-time task)
2. **Create contract registry** (one-time setup)
3. **Update configuration** (one-time update)
4. **Document for developers** (ongoing maintenance)

This approach makes the repo much more developer-friendly while maintaining flexibility for advanced use cases. 