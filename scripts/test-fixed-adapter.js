const { IoTeX } = require("../src/utils/iotex");

async function main() {
  console.log("🧪 Testing Fixed IoTeX Adapter");
  console.log("==============================");
  
  const contractId = process.env.NEXT_PUBLIC_contractId || "ac.proxy.proudbear01.testnet";
  const contractAddress = "0xf3F4cb1D1775ab62c8f1CAAe3a5EE369D89DF910";
  
  try {
    // Test address derivation
    const { address: senderAddress } = await IoTeX.deriveAddressAndPublicKey(
      contractId,
      "iotex-1",
    );
    console.log("✅ Derived address:", senderAddress);
    
    // Test balance
    const balance = await IoTeX.getBalance(senderAddress);
    console.log("✅ Balance:", Number(balance.balance), "IOTX");
    
    // Test transaction preparation with fixed gas
    console.log("\n🔧 Testing fixed gas transaction preparation...");
    
    // Encode function data for updatePrice
    const { Contract } = require("ethers");
    const abi = [
      {
        inputs: [{ internalType: "uint256", name: "_price", type: "uint256" }],
        name: "updatePrice",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
    ];
    
    const iface = new Contract.Interface(abi);
    const data = iface.encodeFunctionData("updatePrice", [12345]);
    
    console.log("✅ Function data encoded");
    
    // Test the fixed adapter
    const result = await IoTeX.prepareTransactionForSigning({
      from: senderAddress,
      to: contractAddress,
      data,
    });
    
    console.log("✅ Transaction preparation successful!");
    console.log("  Transaction object created");
    console.log("  Hashes to sign:", result.hashesToSign.length);
    console.log("  Ready for NEAR signing");
    
    console.log("\n🎉 Fixed adapter is working!");
    
  } catch (error) {
    console.error("❌ Fixed adapter test failed:", error.message);
    console.error("Full error:", error);
  }
}

main()
  .then(() => {
    console.log("\n🏁 Test completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Script failed:", error);
    process.exit(1);
  });
