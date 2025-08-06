# Deploy Smart Contract on IoTeX Testnet

## Prerequisites

1. **IoTeX Testnet Account**: Get some testnet IOTX tokens
2. **Remix IDE** or **Hardhat**: For contract deployment
3. **IoTeX Testnet RPC**: `https://babel-api.testnet.iotex.io`

## Step 1: Get IoTeX Testnet Tokens

Visit the IoTeX testnet faucet:
- **Faucet URL**: https://faucet.iotex.io/
- **Network**: IoTeX Testnet
- **Chain ID**: 4690

## Step 2: Deploy Contract

### Option A: Using Remix IDE

1. Go to https://remix.ethereum.org/
2. Create a new file called `PriceOracle.sol`
3. Paste the contract code:

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

4. Compile the contract
5. Deploy to IoTeX Testnet:
   - **Environment**: Injected Provider - MetaMask
   - **Network**: IoTeX Testnet (Chain ID: 4690)
   - **Account**: Your IoTeX testnet account

### Option B: Using Hardhat

1. Create a new Hardhat project
2. Add IoTeX network configuration:

```javascript
// hardhat.config.js
module.exports = {
  networks: {
    iotexTestnet: {
      url: "https://babel-api.testnet.iotex.io",
      chainId: 4690,
      accounts: [process.env.PRIVATE_KEY]
    }
  }
};
```

3. Deploy using: `npx hardhat run scripts/deploy.js --network iotexTestnet`

## Step 3: Update Configuration

After deployment, update the contract address in your code:

```typescript
// src/utils/iotex.ts
export const iotexContractAddress = "0x..."; // Your deployed contract address
```

## Step 4: Test Contract

Verify the contract deployment:

```bash
# Test contract deployment
curl -X POST https://babel-api.testnet.iotex.io \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getCode",
    "params": ["0xYOUR_CONTRACT_ADDRESS", "latest"],
    "id": 1
  }'
``` 