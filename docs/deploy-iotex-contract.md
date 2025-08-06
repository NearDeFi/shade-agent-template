# Deploy PriceOracle Contract on IoTeX for Cross-Chain Signatures

## Overview

This guide helps IoTeX developers deploy the **PriceOracle contract** on IoTeX testnet and mainnet for cross-chain signature testing with the Shade Agent template.

## Prerequisites

1. **IoTeX Testnet Account**: Get some testnet IOTX tokens
2. **Remix IDE** or **Hardhat**: For contract deployment
3. **IoTeX Testnet RPC**: `https://babel-api.testnet.iotex.io`
4. **IoTeX Mainnet RPC**: `https://babel-api.mainnet.iotex.io`

## Step 1: Get IoTeX Testnet Tokens

Visit the IoTeX testnet faucet:
- **Faucet URL**: https://faucet.iotex.io/
- **Network**: IoTeX Testnet
- **Chain ID**: 4690
- **Token**: IOTX (testnet tokens)

## Step 2: Deploy PriceOracle Contract

### Option A: Using Remix IDE (Recommended for IoTeX Devs)

1. **Go to Remix IDE**: https://remix.ethereum.org/
2. **Create new file**: `PriceOracle.sol`
3. **Paste the PriceOracle contract code**:

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

4. **Compile the contract**:
   - Click "Compile" tab
   - Select compiler version 0.8.0 or higher
   - Click "Compile PriceOracle.sol"

5. **Deploy to IoTeX Testnet**:
   - Go to "Deploy & Run Transactions" tab
   - **Environment**: Injected Provider - MetaMask
   - **Network**: IoTeX Testnet (Chain ID: 4690)
   - **Account**: Your IoTeX testnet account with IOTX tokens
   - Click "Deploy"

6. **Record the deployed contract address** for testnet

7. **Deploy to IoTeX Mainnet** (optional):
   - Switch to IoTeX Mainnet (Chain ID: 4689)
   - Deploy the same contract
   - Record the deployed contract address for mainnet

### Option B: Using Hardhat

1. **Create deployment script**:

```javascript
// scripts/deploy-iotex.js
const hre = require("hardhat");

async function main() {
  const PriceOracle = await hre.ethers.getContractFactory("PriceOracle");
  const priceOracle = await PriceOracle.deploy();
  await priceOracle.deployed();

  console.log("PriceOracle deployed to:", priceOracle.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
```

2. **Add IoTeX network configuration**:

```javascript
// hardhat.config.js
module.exports = {
  networks: {
    iotexTestnet: {
      url: "https://babel-api.testnet.iotex.io",
      chainId: 4690,
      accounts: [process.env.PRIVATE_KEY]
    },
    iotexMainnet: {
      url: "https://babel-api.mainnet.iotex.io", 
      chainId: 4689,
      accounts: [process.env.PRIVATE_KEY]
    }
  }
};
```

3. **Deploy contracts**:
```bash
# Deploy to testnet
npx hardhat run scripts/deploy-iotex.js --network iotexTestnet

# Deploy to mainnet
npx hardhat run scripts/deploy-iotex.js --network iotexMainnet
```

## Step 3: Update Shade Agent Configuration

After deployment, update the contract addresses in the Shade Agent template:

```typescript
// src/utils/iotex.ts
export const iotexContractAddress = "0xYOUR_TESTNET_CONTRACT_ADDRESS";
export const iotexMainnetContractAddress = "0xYOUR_MAINNET_CONTRACT_ADDRESS";
```

## Step 4: Verify Contract Deployment

### Test Contract on IoTeX Testnet:

```bash
# Check if contract is deployed
curl -X POST https://babel-api.testnet.iotex.io \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getCode",
    "params": ["0xYOUR_CONTRACT_ADDRESS", "latest"],
    "id": 1
  }'
```

### Test Contract Functions:

```bash
# Call getPrice() function
curl -X POST https://babel-api.testnet.iotex.io \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_call",
    "params": [{
      "to": "0xYOUR_CONTRACT_ADDRESS",
      "data": "0x8381f58a"
    }, "latest"],
    "id": 1
  }'
```

## Step 5: Test Cross-Chain Signatures

Once deployed, test the IoTeX integration:

```bash
# Test IoTeX account endpoint
curl -X GET "http://localhost:3000/api/iotex-account?network=testnet"

# Test IoTeX transaction endpoint  
curl -X POST "http://localhost:3000/api/iotex-transaction" \
  -H "Content-Type: application/json" \
  -d '{"network": "testnet"}'
```

## Network Information

### IoTeX Testnet:
- **Chain ID**: 4690
- **RPC URL**: `https://babel-api.testnet.iotex.io`
- **Explorer**: https://testnet.iotexscan.io/
- **Faucet**: https://faucet.iotex.io/

### IoTeX Mainnet:
- **Chain ID**: 4689
- **RPC URL**: `https://babel-api.mainnet.iotex.io`
- **Explorer**: https://iotexscan.io/

## Contract ABI

The PriceOracle contract uses this ABI (same as other EVM chains):

```json
[
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "_price",
        "type": "uint256"
      }
    ],
    "name": "updatePrice",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getPrice",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
]
```

## Expected Results

After successful deployment and configuration:

1. **Contract deployed** on IoTeX testnet and mainnet
2. **Contract addresses** updated in `src/utils/iotex.ts`
3. **Cross-chain signatures** working with IoTeX
4. **Price oracle functionality** tested and verified

## Troubleshooting

### Common Issues:

1. **MetaMask not connecting to IoTeX**:
   - Add IoTeX network manually in MetaMask
   - Use Chain ID: 4690 (testnet) or 4689 (mainnet)

2. **Insufficient IOTX for deployment**:
   - Get more tokens from faucet: https://faucet.iotex.io/

3. **Contract deployment fails**:
   - Check gas settings in Remix
   - Ensure you have enough IOTX tokens

4. **RPC connection issues**:
   - Verify RPC URLs are correct
   - Check network connectivity

## Next Steps

After deploying the PriceOracle contract:

1. **Update contract addresses** in the Shade Agent template
2. **Test cross-chain signatures** with IoTeX
3. **Create IoTeX component** for near-multichain
4. **Submit PR** to near-multichain repository

This enables IoTeX developers to participate in cross-chain signature testing with the Shade Agent ecosystem! 