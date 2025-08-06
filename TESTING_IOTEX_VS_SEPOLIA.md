# Testing IoTeX vs Sepolia in Phala Deployment

## Overview

This guide helps you test and compare the functionality of your Shade Agent running on IoTeX testnet vs Sepolia (the default). Your Phala deployment is available at: `https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network`

## Prerequisites

1. **Deploy Smart Contract**: Follow `deploy-iotex-contract.md` to deploy on IoTeX testnet
2. **Update Contract Address**: Replace `0x...` in `src/utils/iotex.ts` with your deployed contract address
3. **Redeploy to Phala**: After updating the contract address, redeploy your application

## Testing Strategy

### Phase 1: Contract Deployment Testing

#### Test IoTeX Contract Deployment
```bash
# Test if your IoTeX contract is deployed
curl -X POST https://babel-api.testnet.iotex.io \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getCode",
    "params": ["0xYOUR_IOTEX_CONTRACT_ADDRESS", "latest"],
    "id": 1
  }'
```

#### Test Sepolia Contract Deployment
```bash
# Test if your Sepolia contract is deployed
curl -X POST https://sepolia.drpc.org \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getCode",
    "params": ["0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8", "latest"],
    "id": 1
  }'
```

### Phase 2: Account Derivation Testing

#### Test IoTeX Account Derivation
```bash
# Test IoTeX account derivation (testnet)
curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/iotex-account?network=testnet"

# Test IoTeX account derivation (mainnet)
curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/iotex-account?network=mainnet"
```

#### Test Sepolia Account Derivation
```bash
# Test Sepolia account derivation
curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/eth-account"
```

### Phase 3: Transaction Testing

#### Test IoTeX Transaction
```bash
# Test IoTeX transaction (testnet)
curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/iotex-transaction?network=testnet"

# Test IoTeX transaction (mainnet)
curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/iotex-transaction?network=mainnet"
```

#### Test Sepolia Transaction
```bash
# Test Sepolia transaction
curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/transaction"
```

## Expected Responses

### Successful Account Derivation Response
```json
{
  "senderAddress": "0x...",
  "balance": 1000000000000000000,
  "network": "testnet",
  "chainId": 4690
}
```

### Successful Transaction Response
```json
{
  "txHash": "0x...",
  "newPrice": "1234.56",
  "network": "testnet",
  "chainId": 4690
}
```

## Comparison Testing

### 1. Speed Comparison
```bash
# Time IoTeX transaction
time curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/iotex-transaction?network=testnet"

# Time Sepolia transaction
time curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/transaction"
```

### 2. Gas Cost Comparison
Check transaction costs on respective explorers:
- **IoTeX Testnet**: https://testnet.iotexscan.io/
- **Sepolia**: https://sepolia.etherscan.io/

### 3. Reliability Testing
```bash
# Test multiple IoTeX transactions
for i in {1..5}; do
  echo "IoTeX Transaction $i:"
  curl -s "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/iotex-transaction?network=testnet" | jq '.txHash'
  sleep 2
done

# Test multiple Sepolia transactions
for i in {1..5}; do
  echo "Sepolia Transaction $i:"
  curl -s "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/transaction" | jq '.txHash'
  sleep 2
done
```

## Error Testing

### Test Invalid Network Parameter
```bash
# Test invalid network parameter
curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/iotex-account?network=invalid"
```

### Test Missing Contract ID
```bash
# Test without contract ID (should fail)
curl "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/iotex-transaction?network=testnet"
```

## Frontend Testing

### 1. Update Frontend Configuration
```javascript
// frontend/src/config.js
export const API_URL = "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network";

// Add IoTeX configuration
export const IOTEX_TESTNET_RPC = "https://babel-api.testnet.iotex.io";
export const IOTEX_MAINNET_RPC = "https://babel-api.mainnet.iotex.io";
```

### 2. Test Frontend Integration
```bash
# Start frontend locally
cd frontend
npm run dev

# Test in browser
open http://localhost:3001
```

## Monitoring and Debugging

### 1. Check Phala Logs
```bash
# View your Phala deployment logs
# Go to https://cloud.phala.network/dashboard
# Find your app and check the logs
```

### 2. Monitor Network Status
```bash
# Check IoTeX testnet status
curl -s https://babel-api.testnet.iotex.io \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq

# Check Sepolia status
curl -s https://sepolia.drpc.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq
```

### 3. Compare Block Times
```bash
# IoTeX block time (~5 seconds)
# Sepolia block time (~12 seconds)
```

## Performance Metrics

### Expected Performance Differences

| Metric | IoTeX Testnet | Sepolia |
|--------|---------------|---------|
| Block Time | ~5 seconds | ~12 seconds |
| Gas Cost | Lower | Higher |
| Transaction Speed | Faster | Slower |
| Network Congestion | Lower | Higher |

### Testing Checklist

- [ ] Deploy smart contract on IoTeX testnet
- [ ] Update contract address in configuration
- [ ] Redeploy application to Phala
- [ ] Test account derivation for both chains
- [ ] Test transaction execution for both chains
- [ ] Compare transaction speeds
- [ ] Compare gas costs
- [ ] Test error handling
- [ ] Monitor logs for issues
- [ ] Document findings

## Troubleshooting

### Common Issues

1. **Contract Not Deployed**: Follow deployment guide
2. **RPC Connection Failed**: Check network connectivity
3. **Invalid Contract Address**: Verify address format
4. **Insufficient Funds**: Get testnet tokens from faucet
5. **Transaction Failed**: Check gas limits and network status

### Debug Commands

```bash
# Test RPC connectivity
curl -X POST https://babel-api.testnet.iotex.io \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

# Test your specific endpoint
curl -v "https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network/api/iotex-account?network=testnet"
```

## Next Steps

1. **Deploy Contract**: Follow the deployment guide
2. **Update Configuration**: Replace placeholder contract address
3. **Redeploy**: Push updated code to Phala
4. **Test Thoroughly**: Use the testing commands above
5. **Document Results**: Record performance comparisons
6. **Optimize**: Based on testing results 