#!/bin/bash

# Monitor testnet balances and wait for funding
# Your deployment URL: https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network

DEPLOYMENT_URL="https://83cf07764e2fcd60d039112b7a7b27d7aec9171d-3000.dstack-prod7.phala.network"

# Minimum balance thresholds (in wei)
SEPOLIA_MIN_BALANCE=100000000000000000  # 0.1 ETH
IOTEX_MIN_BALANCE=100000000000000000000  # 100 IOTX

echo "💰 Monitoring Testnet Balances"
echo "=============================="
echo "Deployment URL: $DEPLOYMENT_URL"
echo ""

# Function to format balance
format_balance() {
    local balance=$1
    local decimals=$2
    local symbol=$3
    
    if [ "$balance" -gt 0 ]; then
        # Convert wei to human readable
        local human_balance=$(echo "scale=6; $balance / 10^$decimals" | bc -l 2>/dev/null)
        echo "$human_balance $symbol"
    else
        echo "0 $symbol"
    fi
}

# Function to check if balance is sufficient
check_sufficient_balance() {
    local balance=$1
    local min_balance=$2
    local network=$3
    
    if [ "$balance" -ge "$min_balance" ]; then
        echo "✅ $network: Sufficient balance"
        return 0
    else
        echo "⏳ $network: Waiting for funding..."
        return 1
    fi
}

# Initial check
echo "🔍 Initial Balance Check..."
echo ""

# Get Sepolia balance
SEPOLIA_RESPONSE=$(curl -s "$DEPLOYMENT_URL/api/eth-account")
SEPOLIA_ADDRESS=$(echo $SEPOLIA_RESPONSE | jq -r '.senderAddress' 2>/dev/null)
SEPOLIA_BALANCE=$(echo $SEPOLIA_RESPONSE | jq -r '.balance' 2>/dev/null)

if [ "$SEPOLIA_ADDRESS" != "null" ] && [ "$SEPOLIA_ADDRESS" != "" ]; then
    echo "📋 Sepolia Address: $SEPOLIA_ADDRESS"
    SEPOLIA_FORMATTED=$(format_balance $SEPOLIA_BALANCE 18 "ETH")
    echo "Current Balance: $SEPOLIA_FORMATTED"
    check_sufficient_balance $SEPOLIA_BALANCE $SEPOLIA_MIN_BALANCE "Sepolia"
    SEPOLIA_FUNDED=$?
else
    echo "❌ Failed to get Sepolia address"
    SEPOLIA_FUNDED=1
fi

echo ""

# Get IoTeX balance
IOTEX_RESPONSE=$(curl -s "$DEPLOYMENT_URL/api/iotex-account?network=testnet")
IOTEX_ADDRESS=$(echo $IOTEX_RESPONSE | jq -r '.senderAddress' 2>/dev/null)
IOTEX_BALANCE=$(echo $IOTEX_RESPONSE | jq -r '.balance' 2>/dev/null)

if [ "$IOTEX_ADDRESS" != "null" ] && [ "$IOTEX_ADDRESS" != "" ]; then
    echo "📋 IoTeX Address: $IOTEX_ADDRESS"
    IOTEX_FORMATTED=$(format_balance $IOTEX_BALANCE 18 "IOTX")
    echo "Current Balance: $IOTEX_FORMATTED"
    check_sufficient_balance $IOTEX_BALANCE $IOTEX_MIN_BALANCE "IoTeX"
    IOTEX_FUNDED=$?
else
    echo "❌ Failed to get IoTeX address"
    IOTEX_FUNDED=1
fi

echo ""

# If both are funded, proceed to testing
if [ $SEPOLIA_FUNDED -eq 0 ] && [ $IOTEX_FUNDED -eq 0 ]; then
    echo "🎉 Both networks are funded! Proceeding to transaction testing..."
    echo ""
    
    # Test Sepolia transaction
    echo "🧪 Testing Sepolia Transaction..."
    SEPOLIA_TX_RESPONSE=$(curl -s "$DEPLOYMENT_URL/api/transaction")
    SEPOLIA_TX_HASH=$(echo $SEPOLIA_TX_RESPONSE | jq -r '.txHash' 2>/dev/null)
    SEPOLIA_TX_PRICE=$(echo $SEPOLIA_TX_RESPONSE | jq -r '.newPrice' 2>/dev/null)
    
    if [ "$SEPOLIA_TX_HASH" != "null" ] && [ "$SEPOLIA_TX_HASH" != "" ]; then
        echo "✅ Sepolia Transaction: $SEPOLIA_TX_HASH"
        echo "New Price: $SEPOLIA_TX_PRICE"
        echo "Explorer: https://sepolia.etherscan.io/tx/$SEPOLIA_TX_HASH"
    else
        echo "❌ Sepolia transaction failed"
    fi
    
    echo ""
    
    # Test IoTeX transaction
    echo "🧪 Testing IoTeX Transaction..."
    IOTEX_TX_RESPONSE=$(curl -s "$DEPLOYMENT_URL/api/iotex-transaction?network=testnet")
    IOTEX_TX_HASH=$(echo $IOTEX_TX_RESPONSE | jq -r '.txHash' 2>/dev/null)
    IOTEX_TX_PRICE=$(echo $IOTEX_TX_RESPONSE | jq -r '.newPrice' 2>/dev/null)
    
    if [ "$IOTEX_TX_HASH" != "null" ] && [ "$IOTEX_TX_HASH" != "" ]; then
        echo "✅ IoTeX Transaction: $IOTEX_TX_HASH"
        echo "New Price: $IOTEX_TX_PRICE"
        echo "Explorer: https://testnet.iotexscan.io/tx/$IOTEX_TX_HASH"
    else
        echo "❌ IoTeX transaction failed"
    fi
    
    echo ""
    echo "📊 Performance Comparison:"
    echo "========================="
    echo "Check the transaction hashes above to compare:"
    echo "- Transaction speed (block confirmation time)"
    echo "- Gas costs (on respective explorers)"
    echo "- Network reliability"
    
else
    echo "⏳ Waiting for funding..."
    echo "Please fund the addresses above and run this script again."
    echo ""
    echo "💡 Tip: You can also use the frontend UI to monitor balances:"
    echo "cd frontend && npm run dev"
    echo "Then visit: http://localhost:3001"
fi 