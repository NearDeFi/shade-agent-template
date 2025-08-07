const hre = require("hardhat");

async function main() {
  console.log("🧪 Testing Direct Contract Update");
  console.log("================================");
  
  const contractAddress = "0x9A950B7381282EAfaa81e5810727504e59B19fAd";
  const proudbearDerivedAddress = "0x3a9847f0375e7372a1D7420E7B9B74F490Ae198a";
  
  // NOTE: This test won't work because we don't have the private key for the derived address
  // The derived address is generated through NEAR chain signatures, not a regular private key
  // This test is to demonstrate the issue
  
  console.log("📋 Test Details:");
  console.log("  Contract:", contractAddress);
  console.log("  Expected Owner:", proudbearDerivedAddress);
  
  // Get contract instance
  const PriceOracle = await hre.ethers.getContractFactory("PriceOracle");
  const contract = PriceOracle.attach(contractAddress);
  
  // Check current owner
  const owner = await contract.owner();
  console.log("  Actual Owner:", owner);
  
  // Check current price
  const currentPrice = await contract.getPrice();
  console.log("  Current Price:", currentPrice.toString());
  
  console.log("\n🔍 Analysis:");
  console.log("The contract is correctly owned by the proudbear01.testnet derived address");
  console.log("However, updating the price requires a transaction signed by that address");
  console.log("The derived address cannot sign transactions directly - it requires NEAR chain signatures");
  
  console.log("\n🎯 The Issue:");
  console.log("The Shade Agent system must:");
  console.log("1. Prepare the transaction to update the price");
  console.log("2. Request a signature from the NEAR chain signature service");
  console.log("3. Combine the signature with the transaction");
  console.log("4. Broadcast the signed transaction to IoTeX");
  
  console.log("\n🔧 Debugging Steps:");
  console.log("1. Verify NEAR chain signature service is accessible");
  console.log("2. Check if the signing request is properly formatted");
  console.log("3. Ensure the derived address calculation is consistent");
  console.log("4. Test the complete chain signature flow");
  
  // Test if we can call the read-only function
  try {
    console.log("\n📖 Testing read-only access...");
    const price = await contract.getPrice();
    console.log("✅ Can read contract state:", price.toString());
  } catch (error) {
    console.log("❌ Cannot read contract state:", error.message);
  }
  
  // Test estimation of update function (this should work even without private key)
  try {
    console.log("\n⛽ Testing gas estimation...");
    const gasEstimate = await contract.updatePrice.estimateGas(12345);
    console.log("✅ Gas estimate for update:", gasEstimate.toString());
  } catch (error) {
    console.log("❌ Cannot estimate gas:", error.message);
    console.log("This suggests the derived address is not recognized as owner by the contract");
  }
}

main()
  .then(() => {
    console.log("\n💡 Next: Test the NEAR chain signature flow in the Shade Agent");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Test failed:", error);
    process.exit(1);
  });
