const { chainAdapters, contracts } = require("chainsig.js");
const { createPublicClient, http } = require("viem");

async function main() {
  console.log("🔧 NEAR Account Setup for IoTeX Integration");
  console.log("==========================================");
  
  const nearAccountId = process.argv[2];
  
  if (!nearAccountId) {
    console.log("Usage: node scripts/setup-near-account.js <NEAR_ACCOUNT_ID>");
    console.log("");
    console.log("Example:");
    console.log("  node scripts/setup-near-account.js myaccount.testnet");
    console.log("");
    console.log("This will show you:");
    console.log("1. The derived IoTeX address for this NEAR account");
    console.log("2. Instructions for funding the derived address");
    console.log("3. Environment configuration needed");
    process.exit(1);
  }
  
  console.log("NEAR Account:", nearAccountId);
  
  try {
    // Set up the chain signature contract
    const MPC_CONTRACT = new contracts.ChainSignatureContract({
      networkId: "testnet",
      contractId: "v1.signer-prod.testnet",
    });
    
    // Set up IoTeX adapter
    const iotexPublicClient = createPublicClient({
      transport: http("https://babel-api.testnet.iotex.io"),
    });
    
    const IoTeX = new chainAdapters.evm.EVM({
      publicClient: iotexPublicClient,
      contract: MPC_CONTRACT,
    });
    
    // Derive the IoTeX address for this NEAR account
    const { address: derivedAddress } = await IoTeX.deriveAddressAndPublicKey(
      nearAccountId,
      "iotex-1"
    );
    
    console.log("\n📋 Derived Addresses:");
    console.log("  NEAR Account:", nearAccountId);
    console.log("  IoTeX Address:", derivedAddress);
    
    // Check balance of derived address
    const balance = await IoTeX.getBalance(derivedAddress);
    console.log("  Current Balance:", Number(balance.balance).toFixed(6), "IOTX");
    
    console.log("\n⚙️  Environment Configuration:");
    console.log("Update your .env.development.local file:");
    console.log(`NEXT_PUBLIC_contractId=${nearAccountId}`);
    
    console.log("\n💰 Funding Instructions:");
    console.log("1. Send IOTX testnet tokens to:", derivedAddress);
    console.log("2. Visit: https://testnet.iotexscan.io/address/" + derivedAddress);
    
    console.log("\n🔧 Contract Ownership:");
    console.log("Current contract owner:", "0x313655491F1202B7c2B5f3cC5BEecD54C42142c0");
    console.log("New derived address:", derivedAddress);
    
    if (derivedAddress.toLowerCase() !== "0x313655491F1202B7c2B5f3cC5BEecD54C42142c0".toLowerCase()) {
      console.log("⚠️  You'll need to transfer contract ownership to the new address");
      console.log("Or deploy a new contract owned by the new address");
    } else {
      console.log("✅ Addresses match! The setup should work.");
    }
    
    console.log("\n📝 Next Steps:");
    console.log("1. Update .env.development.local with the NEAR account ID");
    console.log("2. Fund the derived IoTeX address");
    console.log("3. Transfer contract ownership (if needed)");
    console.log("4. Test the integration endpoints");
    
  } catch (error) {
    console.error("❌ Error deriving address:", error.message);
    console.log("\nMake sure you have the correct NEAR account format:");
    console.log("- For testnet: account.testnet");
    console.log("- For mainnet: account.near");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Script failed:", error);
    process.exit(1);
  });
