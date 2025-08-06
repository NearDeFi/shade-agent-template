# IoTeX Implementation Guide

## Overview

This guide outlines the complete implementation of IoTeX support in the Shade Agent template, following the **shared contract pattern** established by the [near-multichain](https://github.com/near-examples/near-multichain) example.

## Current Status

### ✅ **Completed:**
- **IoTeX adapter** implemented in `src/utils/iotex.ts`
- **IoTeX routes** implemented in `src/routes/iotexAccount.ts` and `src/routes/iotexTransaction.ts`
- **API integration** in `src/index.ts`
- **Configuration** for testnet and mainnet

### ❌ **Pending:**
- **Contract deployment** on IoTeX testnet and mainnet
- **Contract address update** in configuration
- **Integration** with near-multichain example
- **Testing** with Phala deployment

## Implementation Steps

### Step 1: Deploy IoTeX Contracts

#### Prerequisites:
1. **IoTeX testnet account** with IOTX tokens
2. **Remix IDE** or **Hardhat** for deployment
3. **MetaMask** configured for IoTeX testnet

#### Deployment Process:

**Option A: Using Remix IDE**
1. Go to https://remix.ethereum.org/
2. Create new file `PriceOracle.sol`
3. Paste contract code:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract PriceOracle {
    uint256 private price;
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    function updatePrice(uint256 _price) public onlyOwner {
        price = _price;
    }

    function getPrice() public view returns (uint256) {
        return price;
    }
}
```
4. Compile and deploy to IoTeX testnet (Chain ID: 4690)
5. Record deployed contract addresses

**Option B: Using Hardhat**
```bash
# Create deployment script
npx hardhat run scripts/deploy-iotex.js --network iotexTestnet
npx hardhat run scripts/deploy-iotex.js --network iotexMainnet
```

### Step 2: Update Contract Registry

After deployment, update the contract addresses:

```typescript
// src/utils/contractRegistry.ts
export const EVM_CONTRACT_REGISTRY = {
  // ... existing contracts
  iotex: {
    testnet: "0xDEPLOYED_IOTEX_TESTNET_ADDRESS",
    mainnet: "0xDEPLOYED_IOTEX_MAINNET_ADDRESS"
  }
};
```

### Step 3: Update IoTeX Configuration

```typescript
// src/utils/iotex.ts
import { getContractAddress } from './contractRegistry';

export const iotexContractAddress = getContractAddress('iotex', 'testnet');
export const iotexMainnetContractAddress = getContractAddress('iotex', 'mainnet');
```

### Step 4: Create IoTeX Component for near-multichain

Create a new component following the near-multichain pattern:

```jsx
// src/components/IoTeX.jsx
import PropTypes from "prop-types";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import { useEffect, useState } from "react";
import { useDebounce } from "../hooks/debounce";
import { SIGNET_CONTRACT } from "../config";
import { chainAdapters } from "chainsig.js";
import { createPublicClient, http } from "viem";

const iotexRpcUrl = "https://babel-api.testnet.iotex.io";
const iotexContractAddress = "0xDEPLOYED_IOTEX_ADDRESS";

const publicClient = createPublicClient({
  transport: http(iotexRpcUrl),
});

const IoTeX = new chainAdapters.evm.EVM({
  publicClient,
  contract: SIGNET_CONTRACT,
});

export function IoTeXView({ props: { setStatus } }) {
  const { signedAccountId, signAndSendTransactions } = useWalletSelector();

  const [receiverAddress, setReceiverAddress] = useState(
    "0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6",
  );
  const [transferAmount, setTransferAmount] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState("request");
  const [signedTransaction, setSignedTransaction] = useState(null);
  const [senderAddress, setSenderAddress] = useState("");

  const [derivationPath, setDerivationPath] = useState("iotex-1");
  const debouncedDerivationPath = useDebounce(derivationPath, 500);

  useEffect(() => {
    setSenderAddress("Waiting for you to stop typing...");
  }, [derivationPath]);

  useEffect(() => {
    setIoTeXAddress();

    async function setIoTeXAddress() {
      setStatus("Querying your address and balance");
      setSenderAddress(
        `Deriving address from path ${debouncedDerivationPath}...`,
      );

      const { address } = await IoTeX.deriveAddressAndPublicKey(
        signedAccountId,
        debouncedDerivationPath,
      );

      setSenderAddress(address);

      const balance = await IoTeX.getBalance(address);

      setStatus(
        `Your IoTeX address is: ${address}, balance: ${balance.balance} IOTX`,
      );
    }
  }, [signedAccountId, debouncedDerivationPath, setStatus]);

  async function handleChainSignature() {
    setStatus("🏗️ Creating transaction");

    const {
      transaction: { transaction },
    } = await IoTeX.prepareTransactionForSigning({
      from: senderAddress,
      to: receiverAddress,
      amount: transferAmount * 1e18, // Convert to wei
    });

    setStatus(
      "🕒 Asking MPC to sign the transaction, this might take a while...",
    );

    try {
      const rsvSignatures = await SIGNET_CONTRACT.sign({
        payloads: [transaction.serializeMessage()],
        path: debouncedDerivationPath,
        keyType: "Secp256k1",
        signerAccount: {
          accountId: signedAccountId,
          signAndSendTransactions,
        },
      });

      if (!rsvSignatures[0] || !rsvSignatures[0].signature) {
        throw new Error("Failed to sign transaction");
      }

      const finalizedTransaction = IoTeX.finalizeTransactionSigning({
        transaction,
        rsvSignatures: rsvSignatures[0],
        senderAddress,
      });

      setStatus("✅ Signed payload ready to be relayed to the IoTeX network");
      setSignedTransaction(finalizedTransaction);
      setCurrentStep("relay");
    } catch (error) {
      setStatus(`❌ Error: ${error.message}`);
    }
  }

  async function handleRelayTransaction() {
    setStatus("🚀 Broadcasting transaction to IoTeX network...");

    try {
      const txHash = await IoTeX.broadcastTx(signedTransaction);
      setStatus(
        `✅ Transaction broadcasted! Hash: ${txHash}\n🔗 View on explorer: https://testnet.iotexscan.io/tx/${txHash}`,
      );
      setCurrentStep("complete");
    } catch (error) {
      setStatus(`❌ Error broadcasting transaction: ${error.message}`);
    }
  }

  const handleUIChainSignature = async () => {
    setIsLoading(true);
    await handleChainSignature();
    setIsLoading(false);
  };

  const handleUIRelayTransaction = async () => {
    setIsLoading(true);
    await handleRelayTransaction();
    setIsLoading(false);
  };

  return (
    <div className="container">
      <div className="row">
        <div className="col-md-6">
          <h3>IoTeX Transfer</h3>
          <div className="mb-3">
            <label className="form-label">Derivation Path:</label>
            <input
              type="text"
              className="form-control"
              value={derivationPath}
              onChange={(e) => setDerivationPath(e.target.value)}
              placeholder="iotex-1"
            />
          </div>
          <div className="mb-3">
            <label className="form-label">Sender Address:</label>
            <input
              type="text"
              className="form-control"
              value={senderAddress}
              readOnly
            />
          </div>
          <div className="mb-3">
            <label className="form-label">Receiver Address:</label>
            <input
              type="text"
              className="form-control"
              value={receiverAddress}
              onChange={(e) => setReceiverAddress(e.target.value)}
            />
          </div>
          <div className="mb-3">
            <label className="form-label">Amount (IOTX):</label>
            <input
              type="number"
              className="form-control"
              value={transferAmount}
              onChange={(e) => setTransferAmount(Number(e.target.value))}
            />
          </div>
          {currentStep === "request" && (
            <button
              className="btn btn-primary"
              onClick={handleUIChainSignature}
              disabled={isLoading}
            >
              {isLoading ? "Processing..." : "Request Signature"}
            </button>
          )}
          {currentStep === "relay" && (
            <button
              className="btn btn-success"
              onClick={handleUIRelayTransaction}
              disabled={isLoading}
            >
              {isLoading ? "Broadcasting..." : "Broadcast Transaction"}
            </button>
          )}
        </div>
        <div className="col-md-6">
          <h3>Transaction Status</h3>
          <div className="alert alert-info">{setStatus}</div>
        </div>
      </div>
    </div>
  );
}

IoTeXView.propTypes = {
  props: PropTypes.shape({
    setStatus: PropTypes.func.isRequired,
  }).isRequired,
};
```

### Step 5: Update near-multichain App.jsx

Add IoTeX to the chain options:

```jsx
// src/App.jsx
import { IoTeXView } from "./components/IoTeX";

const otherChains = [
  { value: "BTC", label: "Bitcoin", component: BitcoinView },
  { value: "SOL", label: "Solana", component: SolanaView },
  { value: "SUI", label: "Sui", component: SuiView },
  { value: "APT", label: "Aptos", component: AptosView },
  { value: "XRP", label: "XRP", component: XRPView },
  { value: "IOTX", label: "IoTeX", component: IoTeXView }, // Add this line
];
```

### Step 6: Update Configuration

Add IoTeX to the configuration:

```javascript
// src/config.js
export const CHAIN_ICONS = {
  ETH: "ethereum",
  BASE: "base",
  BNB: "binance",
  AVAX: "avalanche",
  POL: "polygon",
  ARB: "arbitrum",
  BTC: "bitcoin",
  SOL: "solana",
  SUI: "sui",
  APT: "aptos",
  XRP: "xrp",
  IOTX: "iotex", // Add this line
};
```

## Testing Strategy

### Phase 1: Local Testing
```bash
# Test IoTeX account endpoint
curl -X GET "http://localhost:3000/api/iotex-account?network=testnet"

# Test IoTeX transaction endpoint
curl -X POST "http://localhost:3000/api/iotex-transaction" \
  -H "Content-Type: application/json" \
  -d '{"network": "testnet"}'
```

### Phase 2: Phala Testing
```bash
# Test with Phala deployment
curl -X GET "https://your-phala-endpoint/api/iotex-account?network=testnet"
```

### Phase 3: near-multichain Integration
1. **Fork** near-multichain repository
2. **Add IoTeX component** following the pattern
3. **Test locally** with the new component
4. **Submit PR** to near-multichain repository

## Cost Analysis

### **Deployment Costs:**
- **IoTeX Testnet**: ~0.1 IOTX (~$0.01)
- **IoTeX Mainnet**: ~1 IOTX (~$0.10)
- **Total**: < $1 for both networks

### **Transaction Costs:**
- **IoTeX Testnet**: ~0.001 IOTX per transaction
- **IoTeX Mainnet**: ~0.01 IOTX per transaction

## Next Steps

1. **Deploy IoTeX contracts** (one-time task)
2. **Update contract addresses** in configuration
3. **Create IoTeX component** for near-multichain
4. **Test integration** thoroughly
5. **Submit PR** to near-multichain repository
6. **Document process** for future reference

## Conclusion

Following the **shared contract pattern** from near-multichain, IoTeX implementation will provide:
- **Consistent developer experience** across all EVM networks
- **Zero deployment requirement** for new developers
- **Flexible configuration** for advanced users
- **Cost efficiency** through shared contracts

This approach ensures IoTeX integration follows the same proven pattern as other EVM networks in the ecosystem. 