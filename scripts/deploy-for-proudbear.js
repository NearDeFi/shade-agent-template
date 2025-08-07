const hre = require("hardhat");

async function main() {
  console.log("🚀 Deploying PriceOracle for proudbear01.testnet");
  console.log("===============================================");
  
  const proudbearDerivedAddress = "0x3a9847f0375e7372a1D7420E7B9B74F490Ae198a";
  
  // Check if the derived address has funds to deploy
  const balance = await hre.ethers.provider.getBalance(proudbearDerivedAddress);
  const balanceInEth = hre.ethers.formatEther(balance);
  
  console.log("📋 Deployment Details:");
  console.log("  NEAR Account: proudbear01.testnet");
  console.log("  Derived IoTeX Address:", proudbearDerivedAddress);
  console.log("  Current Balance:", balanceInEth, "IOTX");
  
  if (balance === 0n) {
    console.log("\n❌ The derived address has no IOTX tokens for deployment");
    console.log("💰 Please send some IOTX testnet tokens to:", proudbearDerivedAddress);
    console.log("🔗 You can check the address here: https://testnet.iotexscan.io/address/" + proudbearDerivedAddress);
    console.log("\nAlternatively, I can deploy using the funded wallet and then transfer ownership...");
    
    // Deploy with funded wallet and transfer ownership
    console.log("\n🔄 Deploying with funded wallet and transferring ownership...");
    
    const wallet = new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider);
    console.log("Deploying with wallet:", wallet.address);
    
    // Get the contract factory
    const PriceOracle = await hre.ethers.getContractFactory("PriceOracle", wallet);
    
    // Deploy the contract
    console.log("Deploying PriceOracle...");
    const priceOracle = await PriceOracle.deploy();
    
    // Wait for deployment to complete
    await priceOracle.waitForDeployment();
    
    const contractAddress = await priceOracle.getAddress();
    console.log("✅ PriceOracle deployed to:", contractAddress);
    
    // Immediately transfer ownership to proudbear derived address
    console.log("🔄 Transferring ownership to proudbear01.testnet derived address...");
    const transferTx = await priceOracle.transferOwnership(proudbearDerivedAddress);
    await transferTx.wait();
    
    // Verify the transfer
    const newOwner = await priceOracle.owner();
    console.log("✅ New owner:", newOwner);
    
    if (newOwner.toLowerCase() === proudbearDerivedAddress.toLowerCase()) {
      console.log("🎉 Success! Contract deployed and ownership transferred");
      
      console.log("\n=== New Contract Details ===");
      console.log("Contract Address:", contractAddress);
      console.log("Owner (proudbear01.testnet):", newOwner);
      console.log("Explorer:", `https://testnet.iotexscan.io/address/${contractAddress}`);
      
      console.log("\n📝 Update Configuration:");
      console.log("Update src/utils/iotex.ts with new contract address:");
      console.log(`export const iotexContractAddress = "${contractAddress}";`);
      
      return contractAddress;
    } else {
      console.log("❌ Ownership transfer failed");
      return null;
    }
    
  } else {
    console.log("✅ Derived address has sufficient balance for deployment");
    // TODO: Deploy directly from derived address (would need the private key derivation)
    console.log("💡 For now, deploying with funded wallet and transferring ownership...");
    
    // Use the same approach as above
    const wallet = new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider);
    const PriceOracle = await hre.ethers.getContractFactory("PriceOracle", wallet);
    const priceOracle = await PriceOracle.deploy();
    await priceOracle.waitForDeployment();
    
    const contractAddress = await priceOracle.getAddress();
    console.log("✅ PriceOracle deployed to:", contractAddress);
    
    const transferTx = await priceOracle.transferOwnership(proudbearDerivedAddress);
    await transferTx.wait();
    
    const newOwner = await priceOracle.owner();
    console.log("✅ Ownership transferred to:", newOwner);
    
    return contractAddress;
  }
}

main()
  .then((contractAddress) => {
    if (contractAddress) {
      console.log(`\n🎉 Deployment completed successfully!`);
      console.log(`New contract address: ${contractAddress}`);
      console.log(`Ready for proudbear01.testnet Shade Agent integration!`);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
