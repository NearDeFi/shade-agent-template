const hre = require("hardhat");

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error("PRIVATE_KEY not set in environment");
    process.exit(1);
  }

  // Create wallet from private key
  const wallet = new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider);
  
  console.log("Checking wallet balance...");
  console.log("Network:", hre.network.name);
  console.log("Wallet Address:", wallet.address);
  
  // Get balance
  const balance = await hre.ethers.provider.getBalance(wallet.address);
  const balanceInEth = hre.ethers.formatEther(balance);
  
  console.log("Balance:", balanceInEth, "IOTX");
  
  // Check if we have enough for deployment (typically needs ~0.01 IOTX)
  const minRequired = hre.ethers.parseEther("0.01");
  
  if (balance >= minRequired) {
    console.log("✅ Sufficient balance for contract deployment!");
    return true;
  } else {
    console.log("❌ Insufficient balance for deployment");
    console.log("Need at least 0.01 IOTX for deployment");
    return false;
  }
}

main()
  .then((hasBalance) => {
    if (hasBalance) {
      console.log("\nReady to deploy! Run:");
      console.log("npm run deploy:iotex-testnet");
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error checking balance:", error);
    process.exit(1);
  });
