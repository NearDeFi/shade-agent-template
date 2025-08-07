const hre = require("hardhat");

async function main() {
  console.log("Deploying PriceOracle contract...");
  
  // Get the contract factory
  const PriceOracle = await hre.ethers.getContractFactory("PriceOracle");
  
  // Deploy the contract
  console.log("Deploying to network:", hre.network.name);
  const priceOracle = await PriceOracle.deploy();
  
  // Wait for deployment to complete
  await priceOracle.waitForDeployment();
  
  const contractAddress = await priceOracle.getAddress();
  console.log("PriceOracle deployed to:", contractAddress);
  
  // Get deployment transaction
  const deploymentTransaction = priceOracle.deploymentTransaction();
  console.log("Deployment transaction hash:", deploymentTransaction?.hash);
  
  // Verify the deployment
  const owner = await priceOracle.owner();
  console.log("Contract owner:", owner);
  
  // Get some network info
  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  console.log("Network details:");
  console.log("  Name:", network.name);
  console.log("  Chain ID:", network.chainId.toString());
  
  console.log("\n=== Deployment Summary ===");
  console.log(`Contract Address: ${contractAddress}`);
  console.log(`Network: ${hre.network.name} (Chain ID: ${network.chainId})`);
  console.log(`Owner: ${owner}`);
  console.log(`Transaction Hash: ${deploymentTransaction?.hash}`);
  
  if (hre.network.name === "iotexTestnet") {
    console.log(`Explorer: https://testnet.iotexscan.io/address/${contractAddress}`);
  } else if (hre.network.name === "iotexMainnet") {
    console.log(`Explorer: https://iotexscan.io/address/${contractAddress}`);
  }
  
  return contractAddress;
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then((contractAddress) => {
    console.log(`\nDeployment completed successfully!`);
    console.log(`Copy this address to your iotex.ts configuration: ${contractAddress}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
