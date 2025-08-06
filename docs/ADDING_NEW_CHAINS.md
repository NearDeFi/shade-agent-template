# Adding New Chains to Shade Agent Template

This guide provides a step-by-step methodology for adding new blockchain networks to the Shade Agent template. Based on the successful integration of IoTeX, this document outlines the systematic approach for expanding the template's multi-chain capabilities.

## Table of Contents

1. [Chain Investigation Methodology](#chain-investigation-methodology)
2. [Supported Chain Types](#supported-chain-types)
3. [Implementation Patterns](#implementation-patterns)
4. [Step-by-Step Guide](#step-by-step-guide)
5. [Testing Strategy](#testing-strategy)
6. [Common Issues and Solutions](#common-issues-and-solutions)
7. [Examples](#examples)
8. [Best Practices](#best-practices)

## Chain Investigation Methodology

### Step 1: Research Chain Characteristics

Before implementing a new chain, investigate these key characteristics:

#### Blockchain Type
- **EVM-Compatible**: Uses Ethereum Virtual Machine (Ethereum, Polygon, Arbitrum, etc.)
- **Solana-Based**: Uses Solana's programming model
- **Move-Based**: Uses Move programming language (Aptos, Sui)
- **Other**: Bitcoin, Cosmos, XRP, etc.

#### Technical Specifications
- **Consensus Mechanism**: Proof of Work, Proof of Stake, etc.
- **Native Token**: What's the native currency?
- **Smart Contract Support**: Solidity, Move, Rust, etc.
- **Block Time**: Transaction confirmation speed
- **Gas Model**: Fee structure and gas limits

#### Network Information
- **RPC Endpoints**: Available RPC URLs for testnet/mainnet
- **Chain IDs**: Network identifiers
- **Explorer URLs**: Block explorer for transaction monitoring
- **Documentation**: Official chain documentation

### Step 2: Check chainsig.js Compatibility

Test if the chain is supported by the `chainsig.js` library:

```javascript
// Test chain adapter availability
const { chainAdapters } = require('chainsig.js');
console.log('Available adapters:', Object.keys(chainAdapters));

// Test specific adapter creation
const adapter = new chainAdapters.evm.EVM({...});
console.log('Adapter methods:', Object.getOwnPropertyNames(adapter.constructor.prototype));
```

### Step 3: Test RPC Connectivity

Verify the chain's RPC endpoints are accessible:

```javascript
// Test RPC endpoint connectivity
const response = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'eth_chainId', // or chain-specific method
    params: [],
    id: 1,
  }),
});

if (response.ok) {
  const data = await response.json();
  console.log('Chain ID:', parseInt(data.result, 16));
}
```

## Supported Chain Types

### EVM-Compatible Chains
These chains use the Ethereum Virtual Machine and can reuse the existing EVM adapter:

- **Ethereum** (Sepolia, Mainnet)
- **Polygon** (Mumbai, Mainnet)
- **Arbitrum** (Sepolia, Mainnet)
- **Base** (Sepolia, Mainnet)
- **Optimism** (Sepolia, Mainnet)
- **IoTeX** (Testnet, Mainnet) ✅ **Recently Added**
- **BSC** (Testnet, Mainnet)
- **Avalanche** (Fuji, Mainnet)

### Non-EVM Chains
These chains require chain-specific adapters:

- **Solana** (Devnet, Mainnet)
- **Aptos** (Devnet, Mainnet)
- **Bitcoin** (Testnet, Mainnet)
- **Cosmos** (Testnet, Mainnet)
- **Sui** (Testnet, Mainnet)
- **XRP** (Testnet, Mainnet)

## Implementation Patterns

### For EVM-Compatible Chains

EVM chains require minimal code changes since they can reuse the existing EVM adapter:

```typescript
// 1. Create chain configuration
export const chainRpcUrl = "https://chain-rpc-endpoint.com";
export const chainContractAddress = "0x...";

// 2. Create EVM adapter
export const ChainAdapter = new chainAdapters.evm.EVM({
  publicClient: createPublicClient({
    transport: http(chainRpcUrl),
  }),
  contract: MPC_CONTRACT,
}) as any;

// 3. Create route handler
app.get("/", async (c) => {
  const { address } = await ChainAdapter.deriveAddressAndPublicKey(
    contractId,
    "chain-1", // Chain-specific path
  );
  // ... rest of implementation
});
```

### For Non-EVM Chains

Non-EVM chains require chain-specific adapters and implementation:

```typescript
// 1. Create chain-specific adapter
const chainAdapter = new chainAdapters.chainType.ChainType({
  rpcUrl: 'https://chain-rpc.com',
  contract: MPC_CONTRACT,
});

// 2. Create chain-specific route handler
app.get("/", async (c) => {
  const { address } = await chainAdapter.deriveAddressAndPublicKey(
    contractId,
    "chain-1",
  );
  // ... chain-specific implementation
});
```

## Step-by-Step Guide

### Phase 1: Research and Planning

1. **Research the Chain**
   - Visit the chain's official website
   - Read technical documentation
   - Check RPC endpoint availability
   - Verify chain IDs and network information

2. **Test Compatibility**
   ```bash
   # Create a test script
   node -e "
   const { chainAdapters } = require('chainsig.js');
   console.log('Available adapters:', Object.keys(chainAdapters));
   "
   ```

3. **Test RPC Connectivity**
   ```bash
   # Test RPC endpoint
   curl -X POST https://chain-rpc-endpoint.com \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
   ```

### Phase 2: Configuration Setup

1. **Create Chain Configuration File**
   ```typescript
   // src/utils/{chainName}.ts
   import { contracts, chainAdapters } from "chainsig.js";
   import { createPublicClient, http } from "viem";

   export const chainRpcUrl = "https://chain-rpc-endpoint.com";
   export const chainContractAddress = "0x..."; // Deploy contract here

   // Create chain adapter
   export const ChainAdapter = new chainAdapters.evm.EVM({
     publicClient: createPublicClient({
       transport: http(chainRpcUrl),
     }),
     contract: MPC_CONTRACT,
   }) as any;
   ```

2. **Deploy Smart Contract**
   - Deploy the price oracle contract on the target chain
   - Record the contract address
   - Update configuration files

### Phase 3: Route Implementation

1. **Create Account Route**
   ```typescript
   // src/routes/{chainName}Account.ts
   import { Hono } from "hono";
   import { ChainAdapter } from "../utils/{chainName}";

   const app = new Hono();

   app.get("/", async (c) => {
     const contractId = process.env.NEXT_PUBLIC_contractId;
     try {
       const { address: senderAddress } = await ChainAdapter.deriveAddressAndPublicKey(
         contractId,
         "chain-1", // Chain-specific path
       );

       const balance = await ChainAdapter.getBalance(senderAddress);
       
       return c.json({ senderAddress, balance: Number(balance.balance) });
     } catch (error) {
       console.log("Error getting the derived address:", error);
       return c.json({ error: "Failed to get the derived address" }, 500);
     }
   });

   export default app;
   ```

2. **Create Transaction Route**
   ```typescript
   // src/routes/{chainName}Transaction.ts
   import { Hono } from "hono";
   import { requestSignature } from "@neardefi/shade-agent-js";
   import { ChainAdapter } from "../utils/{chainName}";
   import { utils } from "chainsig.js";
   
   const { toRSV, uint8ArrayToHex } = utils.cryptography;
   const app = new Hono();

   app.get("/", async (c) => {
     try {
       const contractId = process.env.NEXT_PUBLIC_contractId;
       if (!contractId) {
         return c.json({ error: "Contract ID not configured" }, 500);
       }

       // Get price and prepare transaction
       const { transaction, hashesToSign } = await getChainPricePayload(contractId);

       // Request signature
       const signRes = await requestSignature({
         path: "chain-1", // Chain-specific path
         payload: uint8ArrayToHex(hashesToSign[0]),
       });

       // Finalize and broadcast
       const signedTransaction = ChainAdapter.finalizeTransactionSigning({
         transaction,
         rsvSignatures: [toRSV(signRes)],
       });

       const txHash = await ChainAdapter.broadcastTx(signedTransaction);

       return c.json({
         txHash: txHash.hash,
         newPrice: price.toFixed(2),
       });
     } catch (error) {
       console.error("Failed to send the transaction:", error);
       return c.json({ error: "Failed to send the transaction" }, 500);
     }
   });

   export default app;
   ```

### Phase 4: Main Application Updates

1. **Update Main Index**
   ```typescript
   // src/index.ts
   import chainAccount from "./routes/{chainName}Account";
   import chainTransaction from "./routes/{chainName}Transaction";

   // Add routes
   app.route("/api/{chainName}-account", chainAccount);
   app.route("/api/{chainName}-transaction", chainTransaction);
   ```

2. **Update Frontend Configuration**
   ```javascript
   // frontend/src/{chainName}.js
   import { Contract, JsonRpcProvider } from "ethers";

   export const chainRpcUrl = "https://chain-rpc-endpoint.com";
   export const chainContractAddress = "0x...";

   const provider = new JsonRpcProvider(chainRpcUrl);
   const contract = new Contract(chainContractAddress, contractAbi, provider);

   export async function getChainContractPrice() {
     return await contract.getPrice();
   }
   ```

### Phase 5: Testing and Validation

1. **Test Chain Adapter**
   ```javascript
   // Test adapter creation
   const adapter = new chainAdapters.chainType.ChainType({...});
   console.log('Adapter created successfully');
   ```

2. **Test RPC Connectivity**
   ```javascript
   // Test RPC connection
   const response = await fetch(rpcUrl, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       jsonrpc: '2.0',
       method: 'eth_chainId',
       params: [],
       id: 1,
     }),
   });
   ```

3. **Test End-to-End Functionality**
   ```bash
   # Test account derivation
   curl "http://localhost:3000/api/{chainName}-account"

   # Test transaction
   curl "http://localhost:3000/api/{chainName}-transaction"
   ```

## Testing Strategy

### 1. Unit Testing
- Test chain adapter creation
- Test address derivation
- Test transaction preparation
- Test error handling

### 2. Integration Testing
- Test end-to-end price oracle functionality
- Test cross-chain signature verification
- Test error handling and recovery

### 3. Network Testing
- Test chain connectivity
- Test contract deployment
- Test transaction broadcasting
- Test gas estimation

## Common Issues and Solutions

### Issue 1: RPC Connection Failed
**Symptoms**: `RPC connection failed` error
**Solution**: 
- Verify RPC URL is correct
- Check network connectivity
- Try alternative RPC endpoints
- Verify chain ID matches

### Issue 2: Adapter Creation Failed
**Symptoms**: `Failed to create adapter` error
**Solution**:
- Verify chainsig.js supports the chain
- Check adapter constructor parameters
- Ensure all required dependencies are installed

### Issue 3: Path Parameter Issues
**Symptoms**: `Invalid path parameter` error
**Solution**:
- Use correct path format: `{chain}-1` for testnet, `{chain}-mainnet` for mainnet
- Verify path is supported by the chain adapter
- Check path parameter documentation

### Issue 4: Contract Deployment Issues
**Symptoms**: `Contract deployment failed` error
**Solution**:
- Ensure sufficient native tokens for deployment
- Verify contract bytecode is correct
- Check gas limits and fees
- Verify network is correct (testnet vs mainnet)

## Examples

### Example 1: Adding IoTeX (EVM-Compatible)

**Research Results**:
- EVM-compatible ✅
- RPC: `https://babel-api.testnet.iotex.io`
- Chain ID: 4690 (testnet), 4689 (mainnet)

**Implementation**:
```typescript
// src/utils/iotex.ts
export const iotexRpcUrl = "https://babel-api.testnet.iotex.io";
export const IoTeX = new chainAdapters.evm.EVM({
  publicClient: createPublicClient({
    transport: http(iotexRpcUrl),
  }),
  contract: MPC_CONTRACT,
}) as any;
```

### Example 2: Adding Solana (Non-EVM)

**Research Results**:
- Non-EVM chain
- RPC: `https://api.devnet.solana.com`
- Program deployment required

**Implementation**:
```typescript
// src/utils/solana.ts
export const solanaRpcUrl = "https://api.devnet.solana.com";
export const Solana = new chainAdapters.solana.Solana({
  rpcUrl: solanaRpcUrl,
  contract: MPC_CONTRACT,
});
```

## Best Practices

### 1. Environment Variables
Use environment variables for chain configuration:
```bash
# .env.development.local
CHAIN_RPC_URL=https://chain-rpc-endpoint.com
CHAIN_CONTRACT_ADDRESS=0x...
CHAIN_CHAIN_ID=1234
```

### 2. Error Handling
Implement comprehensive error handling:
```typescript
try {
  // Chain operations
} catch (error) {
  if (error.message.includes("insufficient funds")) {
    // Handle gas/fee issues
  } else if (error.message.includes("network error")) {
    // Handle network connectivity issues
  }
  throw error;
}
```

### 3. Testing
Test thoroughly before deployment:
- Unit tests for all functions
- Integration tests for end-to-end functionality
- Network tests for connectivity
- Error handling tests

### 4. Documentation
Document chain-specific requirements:
- RPC endpoints and chain IDs
- Contract deployment instructions
- Path parameters and error codes
- Testing procedures

### 5. Configuration Management
Use configuration objects for easy switching:
```typescript
const chainConfig = {
  testnet: {
    rpcUrl: "https://testnet-rpc.com",
    contractAddress: "0x...",
    path: "chain-1",
    chainId: 1234,
  },
  mainnet: {
    rpcUrl: "https://mainnet-rpc.com",
    contractAddress: "0x...",
    path: "chain-mainnet",
    chainId: 5678,
  },
};
```

## Path Parameters Reference

### EVM Chains
- `ethereum-1`, `ethereum-mainnet`
- `polygon-1`, `polygon-mainnet`
- `arbitrum-1`, `arbitrum-mainnet`
- `base-1`, `base-mainnet`
- `optimism-1`, `optimism-mainnet`
- `iotex-1`, `iotex-mainnet`
- `bsc-1`, `bsc-mainnet`
- `avalanche-1`, `avalanche-mainnet`

### Non-EVM Chains
- Solana: `solana-1`, `solana-mainnet`
- Aptos: `aptos-1`, `aptos-mainnet`
- Bitcoin: `bitcoin-1`, `bitcoin-mainnet`
- Cosmos: `cosmos-1`, `cosmos-mainnet`
- Sui: `sui-1`, `sui-mainnet`
- XRP: `xrp-1`, `xrp-mainnet`

## Common RPC URLs

### EVM Testnets
- Sepolia: `https://sepolia.drpc.org`
- Polygon Mumbai: `https://polygon-mumbai.drpc.org`
- Arbitrum Sepolia: `https://arbitrum-sepolia.drpc.org`
- Base Sepolia: `https://base-sepolia.drpc.org`
- Optimism Sepolia: `https://optimism-sepolia.drpc.org`
- IoTeX Testnet: `https://babel-api.testnet.iotex.io`
- BSC Testnet: `https://data-seed-prebsc-1-s1.binance.org:8545`
- Avalanche Fuji: `https://api.avax-test.network/ext/bc/C/rpc`

### Non-EVM Testnets
- Solana Devnet: `https://api.devnet.solana.com`
- Aptos Devnet: `https://fullnode.devnet.aptoslabs.com`
- Bitcoin Testnet: `https://blockstream.info/testnet/api`
- Cosmos Testnet: `https://rpc.testnet.cosmos.network`
- Sui Testnet: `https://fullnode.testnet.sui.io`
- XRP Testnet: `https://s.altnet.rippletest.net:51234`

## Implementation Checklist

### Pre-Implementation
- [ ] Research chain characteristics
- [ ] Verify chainsig.js support
- [ ] Test RPC connectivity
- [ ] Identify chain-specific requirements
- [ ] Plan path parameters

### Implementation
- [ ] Create chain configuration file
- [ ] Deploy smart contract/program
- [ ] Create route handlers
- [ ] Update main application
- [ ] Add frontend support
- [ ] Implement error handling

### Post-Implementation
- [ ] Test all functionality
- [ ] Update documentation
- [ ] Add environment variables
- [ ] Create example usage
- [ ] Update cursor rules

## Future Considerations

### Upcoming Chains
Consider these emerging chains for future integration:
- **Polygon zkEVM**: Layer 2 scaling
- **zkSync Era**: Zero-knowledge scaling
- **StarkNet**: Cairo-based scaling
- **Polkadot**: Multi-chain ecosystem
- **Cardano**: Haskell-based blockchain

### Research Resources
- Chain documentation websites
- RPC provider documentation
- Community forums and Discord
- GitHub repositories
- Official chain explorers

## Conclusion

This guide provides a systematic approach for adding new chains to the Shade Agent template. By following the methodology outlined here, developers can successfully integrate any supported blockchain network while maintaining code quality and reliability.

The key to successful chain integration is thorough research, proper testing, and following established patterns. The IoTeX integration serves as a successful example of this methodology in action.

For additional support, refer to the cursor rules and existing chain implementations in the codebase. 