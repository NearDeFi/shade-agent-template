const hre = require("hardhat");

async function main() {
  console.log("🔍 Verifying proudbear01.testnet IoTeX Setup");
  console.log("==========================================");
  
  const contractAddress = "0x9A950B7381282EAfaa81e5810727504e59B19fAd";
  const proudbearDerivedAddress = "0x3a9847f0375e7372a1D7420E7B9B74F490Ae198a";
  
  // Get contract instance
  const PriceOracle = await hre.ethers.getContractFactory("PriceOracle");
  const contract = PriceOracle.attach(contractAddress);
  
  console.log("📋 Configuration Details:");
  console.log("  NEAR Account: proudbear01.testnet");
  console.log("  Contract Address:", contractAddress);
  console.log("  Derived IoTeX Address:", proudbearDerivedAddress);
  
  // Check contract owner
  const owner = await contract.owner();
  console.log("  Contract Owner:", owner);
  
  // Check if owner matches derived address
  const ownerMatches = owner.toLowerCase() === proudbearDerivedAddress.toLowerCase();
  console.log("  Owner Matches Derived:", ownerMatches ? "✅ Yes" : "❌ No");
  
  // Check current price
  const currentPrice = await contract.getPrice();
  console.log("  Current Price:", currentPrice.toString());
  
  // Check derived address balance
  const balance = await hre.ethers.provider.getBalance(proudbearDerivedAddress);
  const balanceInEth = hre.ethers.formatEther(balance);
  console.log("  Derived Address Balance:", balanceInEth, "IOTX");
  
  // Estimate gas needed for a price update
  try {
    const gasEstimate = await contract.updatePrice.estimateGas(12345);
    const gasPrice = await hre.ethers.provider.getFeeData();
    const estimatedCost = gasEstimate * gasPrice.gasPrice;
    const estimatedCostInEth = hre.ethers.formatEther(estimatedCost);
    
    console.log("\n💰 Transaction Cost Estimation:");
    console.log("  Gas Needed:", gasEstimate.toString());
    console.log("  Gas Price:", hre.ethers.formatUnits(gasPrice.gasPrice, "gwei"), "gwei");
    console.log("  Estimated Cost:", estimatedCostInEth, "IOTX");
    
    if (balance >= estimatedCost) {
      console.log("  ✅ Sufficient balance for transactions");
    } else {
      console.log("  ❌ Insufficient balance for transactions");
      console.log("  Need:", hre.ethers.formatEther(estimatedCost - balance), "more IOTX");
    }
    
  } catch (error) {
    console.log("  ⚠️ Could not estimate gas (address might need funds first)");
  }
  
  console.log("\n🎯 Status Summary:");
  if (ownerMatches && balance > 0n) {
    console.log("  ✅ Setup is complete and ready for testing!");
  } else if (ownerMatches && balance === 0n) {
    console.log("  ⚠️ Setup is correct but needs funding");
    console.log("  💰 Send IOTX to:", proudbearDerivedAddress);
    console.log("  🔗 Explorer: https://testnet.iotexscan.io/address/" + proudbearDerivedAddress);
  } else {
    console.log("  ❌ Setup needs correction");
  }
  
  console.log("\n📝 Next Steps:");
  if (balance === 0n) {
    console.log("  1. Send ~0.1 IOTX to the derived address for gas fees");
    console.log("  2. Test the price oracle update endpoint");
    console.log("  3. Verify the Shade Agent integration works");
  } else {
    console.log("  1. Test the endpoints: /api/iotex-account and /api/iotex-transaction");
    console.log("  2. Verify price updates work correctly");
  }
  
  console.log("\n🔗 Useful Links:");
  console.log("  Contract Explorer: https://testnet.iotexscan.io/address/" + contractAddress);
  console.log("  Address Explorer: https://testnet.iotexscan.io/address/" + proudbearDerivedAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
