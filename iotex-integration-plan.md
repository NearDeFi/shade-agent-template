# IoTeX Integration Plan for Shade Agent Template

## IoTeX Blockchain Analysis

### IoTeX Characteristics
- **Blockchain Type**: EVM-compatible
- **Consensus**: Roll-DPoS (Rolling Delegated Proof of Stake)
- **Native Token**: IOTX
- **Block Time**: ~5 seconds
- **Gas Model**: Similar to Ethereum
- **Smart Contracts**: Solidity compatible

### IoTeX Network Information
- **Mainnet RPC**: `https://babel-api.mainnet.iotex.io`
- **Testnet RPC**: `https://babel-api.testnet.iotex.io`
- **Chain ID**: 4689 (Mainnet), 4690 (Testnet)
- **Explorer**: https://iotexscan.io

## Integration Strategy

Since IoTeX is EVM-compatible, we can leverage the existing EVM adapter in `chainsig.js`. This means minimal code changes are required.

## Implementation Plan

### Phase 1: IoTeX Configuration Setup

#### 1.1 Update Backend Configuration
**File**: `src/utils/ethereum.ts`

```typescript
// Add IoTeX configuration
export const iotexRpcUrl = "https://babel-api.testnet.iotex.io"; // Testnet
export const iotexContractAddress = "0x..."; // Deploy contract here

// Create IoTeX adapter
export const IoTeX = new chainAdapters.evm.EVM({
  publicClient: createPublicClient({
    transport: http(iotexRpcUrl),
  }),
  contract: MPC_CONTRACT,
}) as any;
```

#### 1.2 Update Frontend Configuration
**File**: `frontend/src/ethereum.js`

```javascript
// Add IoTeX configuration
export const iotexRpcUrl = "https://babel-api.testnet.iotex.io";
export const iotexContractAddress = "0x..."; // Same as backend

// Create IoTeX provider and contract
const iotexProvider = new JsonRpcProvider(iotexRpcUrl);
const iotexContract = new Contract(iotexContractAddress, ethContractAbi, iotexProvider);
```

### Phase 2: Route Handler Updates

#### 2.1 Create IoTeX Account Route
**File**: `src/routes/iotexAccount.ts`

```typescript
import { Hono } from "hono";
import { IoTeX } from "../utils/ethereum";

const app = new Hono();

app.get("/", async (c) => {
  const contractId = process.env.NEXT_PUBLIC_contractId;
  try {
    // Derive the IoTeX address
    const { address: senderAddress } = await IoTeX.deriveAddressAndPublicKey(
      contractId,
      "iotex-1", // IoTeX-specific path
    );

    // Get the balance of the address
    const balance = await IoTeX.getBalance(senderAddress);
    
    return c.json({ senderAddress, balance: Number(balance.balance) });
  } catch (error) {
    console.log("Error getting the derived IoTeX address:", error);
    return c.json({ error: "Failed to get the derived IoTeX address" }, 500);
  }
});

export default app;
```

#### 2.2 Create IoTeX Transaction Route
**File**: `src/routes/iotexTransaction.ts`

```typescript
import { Hono } from "hono";
import { requestSignature } from "@neardefi/shade-agent-js";
import {
  ethContractAbi,
  iotexContractAddress,
  iotexRpcUrl,
  IoTeX,
} from "../utils/ethereum";
import { getEthereumPriceUSD } from "../utils/fetch-eth-price";
import { Contract, JsonRpcProvider } from "ethers";
import { utils } from "chainsig.js";
const { toRSV, uint8ArrayToHex } = utils.cryptography;

const app = new Hono();

app.get("/", async (c) => {
  try {
    const contractId = process.env.NEXT_PUBLIC_contractId;
    if (!contractId) {
      return c.json({ error: "Contract ID not configured" }, 500);
    }

    // Get the ETH price (or IOTX price)
    const ethPrice = await getEthereumPriceUSD();
    if (!ethPrice) {
      return c.json({ error: "Failed to fetch ETH price" }, 500);
    }

    // Get the transaction and payload to sign
    const { transaction, hashesToSign } = await getIoTeXPricePayload(
      ethPrice,
      contractId,
    );

    // Call the agent contract to get a signature for the payload
    const signRes = await requestSignature({
      path: "iotex-1", // IoTeX-specific path
      payload: uint8ArrayToHex(hashesToSign[0]),
    });

    // Reconstruct the signed transaction
    const signedTransaction = IoTeX.finalizeTransactionSigning({
      transaction,
      rsvSignatures: [toRSV(signRes)],
    });

    // Broadcast the signed transaction
    const txHash = await IoTeX.broadcastTx(signedTransaction);

    return c.json({
      txHash: txHash.hash,
      newPrice: (ethPrice / 100).toFixed(2),
    });
  } catch (error) {
    console.error("Failed to send the IoTeX transaction:", error);
    return c.json({ error: "Failed to send the IoTeX transaction" }, 500);
  }
});

async function getIoTeXPricePayload(ethPrice: number, contractId: string) {
  // Derive the IoTeX address
  const { address: senderAddress } = await IoTeX.deriveAddressAndPublicKey(
    contractId,
    "iotex-1",
  );
  
  // Create a new JSON-RPC provider for IoTeX
  const provider = new JsonRpcProvider(iotexRpcUrl);
  
  // Create a new contract interface for the IoTeX Oracle contract
  const contract = new Contract(iotexContractAddress, ethContractAbi, provider);
  
  // Encode the function data for the updatePrice function
  const data = contract.interface.encodeFunctionData("updatePrice", [ethPrice]);
  
  // Prepare the transaction for signing 
  const { transaction, hashesToSign } = await IoTeX.prepareTransactionForSigning({
    from: senderAddress,
    to: iotexContractAddress,
    data,
  });

  return { transaction, hashesToSign };
}

export default app;
```

### Phase 3: Main Application Updates

#### 3.1 Update Main Index
**File**: `src/index.ts`

```typescript
// Add IoTeX routes
import iotexAccount from "./routes/iotexAccount";
import iotexTransaction from "./routes/iotexTransaction";

// Add routes
app.route("/api/iotex-account", iotexAccount);
app.route("/api/iotex-transaction", iotexTransaction);
```

### Phase 4: Frontend Updates

#### 4.1 Update Frontend Configuration
**File**: `frontend/src/config.js`

```javascript
// Add IoTeX API endpoints
export const IOTEX_API_URL = "https://babel-api.testnet.iotex.io";
```

#### 4.2 Create IoTeX Frontend Functions
**File**: `frontend/src/iotex.js`

```javascript
import { Contract, JsonRpcProvider } from "ethers";

export const iotexRpcUrl = "https://babel-api.testnet.iotex.io";
export const iotexContractAddress = "0x..."; // Deploy contract here

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
];

const iotexProvider = new JsonRpcProvider(iotexRpcUrl);
const iotexContract = new Contract(iotexContractAddress, iotexContractAbi, iotexProvider);

// Function to get the price from the IoTeX contract
export async function getIoTeXContractPrice() {
  return await iotexContract.getPrice();
}

// Function to format IoTeX balances
export function formatIoTeXBalance(balance, decimals, decimalPlaces = 6) {
  let strValue = balance.toString();

  if (strValue.length <= decimals) {
    strValue = strValue.padStart(decimals + 1, "0");
  }

  const decimalPos = strValue.length - decimals;
  const result = strValue.slice(0, decimalPos) + "." + strValue.slice(decimalPos);

  return parseFloat(result).toFixed(decimalPlaces);
}
```

## Deployment Steps

### Step 1: Deploy Smart Contract on IoTeX
1. Deploy the price oracle contract on IoTeX testnet
2. Record the contract address
3. Update configuration files with the new address

### Step 2: Test IoTeX Integration
1. Test account derivation
2. Test balance checking
3. Test transaction signing and broadcasting
4. Test price oracle functionality

### Step 3: Update Documentation
1. Update README with IoTeX instructions
2. Add IoTeX-specific environment variables
3. Document IoTeX RPC endpoints

## Environment Variables

Add to `.env.development.local`:
```
IOTEX_RPC_URL=https://babel-api.testnet.iotex.io
IOTEX_CONTRACT_ADDRESS=0x...
IOTEX_CHAIN_ID=4690
```

## Testing Strategy

### 1. Unit Tests
- Test IoTeX adapter creation
- Test address derivation
- Test transaction preparation

### 2. Integration Tests
- Test end-to-end price oracle functionality
- Test cross-chain signature verification
- Test error handling

### 3. Network Tests
- Test IoTeX testnet connectivity
- Test contract deployment
- Test transaction broadcasting

## Benefits of IoTeX Integration

1. **EVM Compatibility**: Minimal code changes required
2. **Fast Transactions**: ~5 second block time
3. **Low Gas Fees**: Cost-effective for IoT applications
4. **IoT Focus**: Specialized for IoT use cases
5. **Privacy Features**: Built-in privacy capabilities

## Path Parameters

For IoTeX, we'll use:
- `iotex-1` for testnet
- `iotex-mainnet` for mainnet

## Error Handling

Add IoTeX-specific error handling:
```typescript
try {
  // IoTeX operations
} catch (error) {
  if (error.message.includes("insufficient funds")) {
    // Handle IoTeX-specific gas issues
  }
  throw error;
}
```

## Next Steps

1. **Deploy contract** on IoTeX testnet
2. **Implement configuration** changes
3. **Create route handlers** for IoTeX
4. **Update frontend** to support IoTeX
5. **Test integration** thoroughly
6. **Deploy to production** when ready 