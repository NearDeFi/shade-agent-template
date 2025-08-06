#!/bin/bash

# Test script for Phala deployment functionality
# Your deployment URL: https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network

DEPLOYMENT_URL="https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network"

echo "🧪 Testing Phala Deployment Functionality"
echo "=========================================="
echo "Deployment URL: $DEPLOYMENT_URL"
echo ""

# Test 1: Health Check
echo "1️⃣ Testing Health Check..."
curl -s "$DEPLOYMENT_URL/" | jq '.message' 2>/dev/null || echo "Health check failed"

# Test 2: Agent Account
echo ""
echo "2️⃣ Testing Agent Account..."
curl -s "$DEPLOYMENT_URL/api/agent-account" | jq '.accountId, .balance' 2>/dev/null || echo "Agent account failed"

# Test 3: Sepolia Account
echo ""
echo "3️⃣ Testing Sepolia Account..."
curl -s "$DEPLOYMENT_URL/api/eth-account" | jq '.senderAddress, .balance' 2>/dev/null || echo "Sepolia account failed"

# Test 4: IoTeX Account (Testnet)
echo ""
echo "4️⃣ Testing IoTeX Account (Testnet)..."
curl -s "$DEPLOYMENT_URL/api/iotex-account?network=testnet" | jq '.senderAddress, .balance, .network, .chainId' 2>/dev/null || echo "IoTeX account failed"

# Test 5: IoTeX Account (Mainnet)
echo ""
echo "5️⃣ Testing IoTeX Account (Mainnet)..."
curl -s "$DEPLOYMENT_URL/api/iotex-account?network=mainnet" | jq '.senderAddress, .balance, .network, .chainId' 2>/dev/null || echo "IoTeX mainnet account failed"

# Test 6: Sepolia Transaction
echo ""
echo "6️⃣ Testing Sepolia Transaction..."
curl -s "$DEPLOYMENT_URL/api/transaction" | jq '.txHash, .newPrice' 2>/dev/null || echo "Sepolia transaction failed"

# Test 7: IoTeX Transaction (Testnet)
echo ""
echo "7️⃣ Testing IoTeX Transaction (Testnet)..."
curl -s "$DEPLOYMENT_URL/api/iotex-transaction?network=testnet" | jq '.txHash, .newPrice, .network, .chainId' 2>/dev/null || echo "IoTeX transaction failed"

# Test 8: IoTeX Transaction (Mainnet)
echo ""
echo "8️⃣ Testing IoTeX Transaction (Mainnet)..."
curl -s "$DEPLOYMENT_URL/api/iotex-transaction?network=mainnet" | jq '.txHash, .newPrice, .network, .chainId' 2>/dev/null || echo "IoTeX mainnet transaction failed"

echo ""
echo "✅ Testing Complete!"
echo ""
echo "📊 Summary:"
echo "- Health Check: Should return 'App is running'"
echo "- Agent Account: Should return NEAR account ID and balance"
echo "- Sepolia Account: Should return Ethereum address and balance"
echo "- IoTeX Accounts: Should return IoTeX addresses and balances"
echo "- Transactions: Should return transaction hashes and new prices"
echo ""
echo "🔧 Next Steps:"
echo "1. Deploy smart contract on IoTeX testnet"
echo "2. Update contract address in src/utils/iotex.ts"
echo "3. Redeploy to Phala"
echo "4. Run this test script again" 