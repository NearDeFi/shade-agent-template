const hre = require("hardhat");

async function main() {
  console.log("Transferring PriceOracle ownership to Shade Agent address...");
  
  const contractAddress = "0xFCebaa43749be59b745C6078D985AcD6930d0b5D";
  const shadeAgentAddress = "0x313655491F1202B7c2B5f3cC5BEecD54C42142c0";
  
  const wallet = new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider);
  
  // Get contract instance
  const PriceOracle = await hre.ethers.getContractFactory("PriceOracle");
  const contract = PriceOracle.attach(contractAddress).connect(wallet);
  
  console.log("Contract address:", contractAddress);
  console.log("Current owner:", wallet.address);
  console.log("New owner (Shade Agent):", shadeAgentAddress);
  
  // Check current owner
  const currentOwner = await contract.owner();
  console.log("Contract current owner:", currentOwner);
  
  if (currentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log("❌ You are not the current owner of this contract");
    process.exit(1);
  }
  
  // Transfer ownership
  console.log("\nTransferring ownership...");
  const tx = await contract.transferOwnership(shadeAgentAddress);
  console.log("Transaction submitted:", tx.hash);
  
  // Wait for confirmation
  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt.blockNumber);
  
  // Verify the transfer
  const newOwner = await contract.owner();
  console.log("New contract owner:", newOwner);
  
  if (newOwner.toLowerCase() === shadeAgentAddress.toLowerCase()) {
    console.log("✅ Ownership successfully transferred!");
    console.log("The Shade Agent can now update the price oracle");
  } else {
    console.log("❌ Ownership transfer failed");
  }
  
  console.log("\n=== Summary ===");
  console.log(`Contract: ${contractAddress}`);
  console.log(`Old Owner: ${currentOwner}`);
  console.log(`New Owner: ${newOwner}`);
  console.log(`Transaction: ${tx.hash}`);
  console.log(`Explorer: https://testnet.iotexscan.io/tx/${tx.hash}`);
}

main()
  .then(() => {
    console.log("\n🎉 Ownership transfer completed!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
