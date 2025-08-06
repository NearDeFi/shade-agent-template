#!/bin/bash

# Get testnet wallet addresses for funding
# Your deployment URL: https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network

DEPLOYMENT_URL="https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network"

echo "🔍 Getting Testnet Wallet Addresses"
echo "==================================="
echo "Deployment URL: $DEPLOYMENT_URL"
echo ""

# Get Sepolia address
echo "📋 Sepolia Testnet Address:"
SEPOLIA_RESPONSE=$(curl -s "$DEPLOYMENT_URL/api/eth-account")
SEPOLIA_ADDRESS=$(echo $SEPOLIA_RESPONSE | jq -r '.senderAddress' 2>/dev/null)
SEPOLIA_BALANCE=$(echo $SEPOLIA_RESPONSE | jq -r '.balance' 2>/dev/null)

if [ "$SEPOLIA_ADDRESS" != "null" ] && [ "$SEPOLIA_ADDRESS" != "" ]; then
    echo "Address: $SEPOLIA_ADDRESS"
    echo "Current Balance: $SEPOLIA_BALANCE wei"
    echo "Sepolia Faucet: https://sepoliafaucet.com/"
    echo "Alternative: https://faucet.sepolia.dev/"
else
    echo "❌ Failed to get Sepolia address"
fi

echo ""

# Get IoTeX testnet address
echo "📋 IoTeX Testnet Address:"
IOTEX_RESPONSE=$(curl -s "$DEPLOYMENT_URL/api/iotex-account?network=testnet")
IOTEX_ADDRESS=$(echo $IOTEX_RESPONSE | jq -r '.senderAddress' 2>/dev/null)
IOTEX_BALANCE=$(echo $IOTEX_RESPONSE | jq -r '.balance' 2>/dev/null)

if [ "$IOTEX_ADDRESS" != "null" ] && [ "$IOTEX_ADDRESS" != "" ]; then
    echo "Address: $IOTEX_ADDRESS"
    echo "Current Balance: $IOTEX_BALANCE wei"
    echo "IoTeX Faucet: https://faucet.iotex.io/"
else
    echo "❌ Failed to get IoTeX address"
fi

echo ""
echo "💰 Funding Instructions:"
echo "======================="
echo "1. Copy the addresses above"
echo "2. Visit the respective faucets"
echo "3. Send test tokens to the addresses"
echo "4. Wait for confirmation"
echo "5. Run the balance monitoring script"
echo ""
echo "📊 Expected Balances After Funding:"
echo "- Sepolia: ~0.1 ETH"
echo "- IoTeX: ~100 IOTX" 