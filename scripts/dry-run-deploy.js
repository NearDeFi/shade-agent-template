const hre = require("hardhat");

async function main() {
  console.log("🚀 IoTeX Contract Deployment - DRY RUN");
  console.log("=====================================");
  
  if (!process.env.PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY not set in environment");
    process.exit(1);
  }

  // Create wallet from private key
  const wallet = new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider);
  
  console.log("📋 Deployment Details:");
  console.log("  Network:", hre.network.name);
  console.log("  RPC URL:", hre.network.config.url);
  console.log("  Chain ID:", hre.network.config.chainId);
  console.log("  Deployer Address:", wallet.address);
  
  // Check balance
  const balance = await hre.ethers.provider.getBalance(wallet.address);
  const balanceInEth = hre.ethers.formatEther(balance);
  console.log("  Current Balance:", balanceInEth, "IOTX");
  
  // Estimate deployment cost
  try {
    const PriceOracle = await hre.ethers.getContractFactory("PriceOracle");
    const deployTransaction = PriceOracle.getDeployTransaction();
    
    // Estimate gas
    const gasEstimate = await hre.ethers.provider.estimateGas(deployTransaction);
    const gasPrice = await hre.ethers.provider.getFeeData();
    
    const estimatedCost = gasEstimate * gasPrice.gasPrice;
    const estimatedCostInEth = hre.ethers.formatEther(estimatedCost);
    
    console.log("\n💰 Estimated Deployment Cost:");
    console.log("  Gas Estimate:", gasEstimate.toString());
    console.log("  Gas Price:", hre.ethers.formatUnits(gasPrice.gasPrice, "gwei"), "gwei");
    console.log("  Total Cost:", estimatedCostInEth, "IOTX");
    
    if (balance >= estimatedCost) {
      console.log("  ✅ Sufficient balance for deployment");
    } else {
      console.log("  ❌ Insufficient balance for deployment");
      console.log("  Need:", hre.ethers.formatEther(estimatedCost - balance), "more IOTX");
    }
    
    console.log("\n📄 Contract to Deploy:");
    console.log("  Name: PriceOracle");
    console.log("  Functions:");
    console.log("    - updatePrice(uint256) - Update price oracle");
    console.log("    - getPrice() - Read current price");
    console.log("    - transferOwnership(address) - Transfer ownership");
    console.log("  Owner: Will be set to deployer address");
    
    console.log("\n🔧 What happens next:");
    console.log("  1. Contract will be deployed to IoTeX", hre.network.name);
    console.log("  2. Contract address will be returned");
    console.log("  3. Update src/utils/iotex.ts with new address");
    console.log("  4. Test the integration endpoints");
    
    if (hre.network.name === "iotexTestnet") {
      console.log("  5. Explorer link: https://testnet.iotexscan.io/address/[CONTRACT_ADDRESS]");
    } else {
      console.log("  5. Explorer link: https://iotexscan.io/address/[CONTRACT_ADDRESS]");
    }
    
    console.log("\n⏳ Ready to deploy when wallet is funded!");
    console.log("Command: npm run deploy:iotex-testnet");
    
  } catch (error) {
    console.error("❌ Error estimating deployment:", error.message);
  }
}

main()
  .then(() => {
    console.log("\n✅ Dry run completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Dry run failed:", error);
    process.exit(1);
  });
