const { requestSignature } = require("@neardefi/shade-agent-js");

async function main() {
  console.log("🔍 Testing NEAR Chain Signature Service");
  console.log("=====================================");
  
  const contractId = process.env.NEXT_PUBLIC_contractId;
  
  if (!contractId) {
    console.log("❌ NEXT_PUBLIC_contractId not set in environment");
    process.exit(1);
  }
  
  console.log("Contract ID:", contractId);
  console.log("Testing signature request...");
  
  try {
    // Test a simple signature request
    const testPayload = "74657374"; // "test" in hex
    
    console.log("Requesting signature for test payload...");
    const signRes = await requestSignature({
      path: "iotex-1",
      payload: testPayload,
    });
    
    console.log("✅ Signature request successful!");
    console.log("Response:", signRes);
    
    // Check if we got a valid signature
    if (signRes && (signRes.r || signRes.big_r)) {
      console.log("✅ NEAR chain signature service is working");
      console.log("The IoTeX integration should work now");
    } else {
      console.log("⚠️  Got response but no signature data");
      console.log("Response structure:", Object.keys(signRes || {}));
    }
    
  } catch (error) {
    console.error("❌ Signature request failed:", error.message);
    
    if (error.message.includes("fetch failed")) {
      console.log("\n🔧 Possible causes:");
      console.log("1. NEAR testnet signing service is down");
      console.log("2. Network connectivity issues");
      console.log("3. Incorrect contract ID format");
      console.log("4. Shade Agent service configuration issue");
    } else if (error.message.includes("account")) {
      console.log("\n🔧 Account-related issue:");
      console.log("1. Check if the NEAR account exists");
      console.log("2. Verify the account has permission to use chain signatures");
    }
  }
}

main()
  .then(() => {
    console.log("\n🏁 NEAR signing test completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Test script failed:", error);
    process.exit(1);
  });
