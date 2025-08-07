const hre = require("hardhat");

async function main() {
  console.log("Transferring PriceOracle ownership to proudbear01.testnet derived address...");
  
  const contractAddress = "0xFCebaa43749be59b745C6078D985AcD6930d0b5D";
  const proudbearDerivedAddress = "0x3a9847f0375e7372a1D7420E7B9B74F490Ae198a";
  
  const wallet = new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider);
  
  // Get contract instance
  const PriceOracle = await hre.ethers.getContractFactory("PriceOracle");
  const contract = PriceOracle.attach(contractAddress).connect(wallet);
  
  console.log("Contract address:", contractAddress);
  console.log("Current owner:", wallet.address);
  console.log("New owner (proudbear01.testnet derived):", proudbearDerivedAddress);
  
  // Check current owner
  const currentOwner = await contract.owner();
  console.log("Contract current owner:", currentOwner);
  
  if (currentOwner.toLowerCase() === proudbearDerivedAddress.toLowerCase()) {
    console.log("✅ Contract is already owned by the proudbear01.testnet derived address");
    return;
  }
  
  // Check if we can transfer (must be current owner or previous owner with transfer rights)
  if (currentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    // Try to transfer from the current owner (0x313655491F1202B7c2B5f3cC5BEecD54C42142c0)
    console.log("⚠️  Current owner is different. Attempting to transfer from current owner...");
    
    // This would require the current owner's private key
    console.log("❌ Cannot transfer - we don't control the current owner address");
    console.log("Current owner:", currentOwner);
    console.log("Our wallet:", wallet.address);
    
    console.log("\n🔧 Alternative: Deploy a new contract owned by proudbear01.testnet");
    return;
  }
  
  // Transfer ownership
  console.log("\nTransferring ownership...");
  const tx = await contract.transferOwnership(proudbearDerivedAddress);
  console.log("Transaction submitted:", tx.hash);
  
  // Wait for confirmation
  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt.blockNumber);
  
  // Verify the transfer
  const newOwner = await contract.owner();
  console.log("New contract owner:", newOwner);
  
  if (newOwner.toLowerCase() === proudbearDerivedAddress.toLowerCase()) {
    console.log("✅ Ownership successfully transferred!");
    console.log("The proudbear01.testnet Shade Agent can now update the price oracle");
  } else {
    console.log("❌ Ownership transfer failed");
  }
  
  console.log("\n=== Summary ===");
  console.log(`Contract: ${contractAddress}`);
  console.log(`NEAR Account: proudbear01.testnet`);
  console.log(`IoTeX Address: ${proudbearDerivedAddress}`);
  console.log(`New Owner: ${newOwner}`);
  console.log(`Transaction: ${tx.hash}`);
  console.log(`Explorer: https://testnet.iotexscan.io/tx/${tx.hash}`);
}

main()
  .then(() => {
    console.log("\n🎉 Setup completed for proudbear01.testnet!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
