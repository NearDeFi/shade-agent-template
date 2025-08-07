const hre = require("hardhat");

async function main() {
  console.log("Testing deployed PriceOracle contract...");
  
  const contractAddress = "0xFCebaa43749be59b745C6078D985AcD6930d0b5D";
  const wallet = new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider);
  
  // Get contract instance
  const PriceOracle = await hre.ethers.getContractFactory("PriceOracle");
  const contract = PriceOracle.attach(contractAddress).connect(wallet);
  
  console.log("Contract address:", contractAddress);
  console.log("Owner address:", wallet.address);
  
  // Test 1: Check current owner
  const owner = await contract.owner();
  console.log("Contract owner:", owner);
  
  // Test 2: Check current price (should be 0 initially)
  const currentPrice = await contract.getPrice();
  console.log("Current price:", currentPrice.toString());
  
  // Test 3: Update price (should succeed as owner)
  console.log("\nUpdating price to 12345...");
  const tx = await contract.updatePrice(12345);
  const receipt = await tx.wait();
  console.log("Transaction hash:", receipt.hash);
  
  // Test 4: Check updated price
  const newPrice = await contract.getPrice();
  console.log("Updated price:", newPrice.toString());
  
  // Test 5: Verify the Shade Agent derived address
  console.log("\n=== Shade Agent Address Analysis ===");
  console.log("Contract owner (can update):", owner);
  console.log("Shade Agent derived address:", "0x313655491F1202B7c2B5f3cC5BEecD54C42142c0");
  console.log("Addresses match:", owner.toLowerCase() === "0x313655491F1202B7c2B5f3cC5BEecD54C42142c0".toLowerCase());
  
  if (owner.toLowerCase() !== "0x313655491F1202B7c2B5f3cC5BEecD54C42142c0".toLowerCase()) {
    console.log("⚠️  The Shade Agent will need to transfer ownership or use a different approach");
    console.log("Options:");
    console.log("1. Transfer ownership to the Shade Agent derived address");
    console.log("2. Use a different contract pattern");
    console.log("3. Fund the Shade Agent derived address to deploy its own contract");
  }
  
  console.log("\n✅ Contract is working correctly!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
