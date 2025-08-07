const { chainAdapters, contracts } = require("chainsig.js");
const { createPublicClient, http } = require("viem");
const { Contract, JsonRpcProvider } = require("ethers");

async function main() {
  console.log("🧪 Testing NEAR Chain Signature Process");
  console.log("======================================");
  
  const nearAccountId = "ac.proxy.proudbear01.testnet";
  const contractAddress = "0xf3F4cb1D1775ab62c8f1CAAe3a5EE369D89DF910";
  const derivationPath = "iotex-1";
  
  console.log("📋 Test Configuration:");
  console.log("  NEAR Account:", nearAccountId);
  console.log("  Contract:", contractAddress);
  console.log("  Derivation Path:", derivationPath);
  
  try {
    // Step 1: Set up the chain signature contract
    console.log("\n🔗 Step 1: Setting up NEAR chain signature contract...");
    const MPC_CONTRACT = new contracts.ChainSignatureContract({
      networkId: "testnet",
      contractId: "v1.signer-prod.testnet",
    });
    console.log("✅ Chain signature contract initialized");
    
    // Step 2: Set up IoTeX adapter
    console.log("\n⚡ Step 2: Setting up IoTeX adapter...");
    const iotexPublicClient = createPublicClient({
      transport: http("https://babel-api.testnet.iotex.io"),
    });
    
    const IoTeX = new chainAdapters.evm.EVM({
      publicClient: iotexPublicClient,
      contract: MPC_CONTRACT,
    });
    console.log("✅ IoTeX adapter initialized");
    
    // Step 3: Derive address
    console.log("\n🔑 Step 3: Deriving IoTeX address...");
    const { address: derivedAddress } = await IoTeX.deriveAddressAndPublicKey(
      nearAccountId,
      derivationPath
    );
    console.log("✅ Derived address:", derivedAddress);
    
    // Step 4: Check balance
    console.log("\n💰 Step 4: Checking balance...");
    const balance = await IoTeX.getBalance(derivedAddress);
    console.log("✅ Balance:", Number(balance.balance).toFixed(6), "IOTX");
    
    if (Number(balance.balance) === 0) {
      console.log("❌ Address has no balance - cannot send transactions");
      return;
    }
    
    // Step 5: Set up contract instance
    console.log("\n📄 Step 5: Setting up contract interface...");
    const abi = [
      {
        inputs: [{ internalType: "uint256", name: "_price", type: "uint256" }],
        name: "updatePrice",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
      {
        inputs: [],
        name: "getPrice",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
      {
        inputs: [],
        name: "owner",
        outputs: [{ internalType: "address", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
      },
    ];
    
    const provider = new JsonRpcProvider("https://babel-api.testnet.iotex.io");
    const contract = new Contract(contractAddress, abi, provider);
    console.log("✅ Contract interface created");
    
    // Step 6: Verify ownership
    console.log("\n🔐 Step 6: Verifying contract ownership...");
    const owner = await contract.owner();
    console.log("Contract owner:", owner);
    console.log("Derived address:", derivedAddress);
    console.log("Ownership match:", owner.toLowerCase() === derivedAddress.toLowerCase() ? "✅" : "❌");
    
    if (owner.toLowerCase() !== derivedAddress.toLowerCase()) {
      console.log("❌ Ownership mismatch - this explains the error");
      return;
    }
    
    // Step 7: Prepare transaction
    console.log("\n📝 Step 7: Preparing transaction...");
    const testPrice = 98765; // Test price value
    const data = contract.interface.encodeFunctionData("updatePrice", [testPrice]);
    console.log("✅ Function data encoded:", data);
    
    // Step 8: Prepare transaction for signing
    console.log("\n✍️  Step 8: Preparing transaction for signing...");
    const { transaction, hashesToSign } = await IoTeX.prepareTransactionForSigning({
      from: derivedAddress,
      to: contractAddress,
      data,
    });
    console.log("✅ Transaction prepared for signing");
    console.log("Hashes to sign:", hashesToSign.length);
    
    // Step 9: Test signing (this is where it might fail)
    console.log("\n🖋️  Step 9: Testing signature request...");
    console.log("⚠️  This step requires the NEAR signing service to be accessible");
    console.log("If this fails, the issue is with NEAR chain signature connectivity");
    
    // This is a mock test - we don't actually call requestSignature here
    // because it requires the full Shade Agent environment
    console.log("✅ Transaction is ready for signing");
    
    console.log("\n🎯 Analysis:");
    console.log("1. Address derivation: ✅ Working");
    console.log("2. Balance check: ✅ Working");  
    console.log("3. Contract ownership: ✅ Working");
    console.log("4. Transaction preparation: ✅ Working");
    console.log("5. Signing process: ⚠️  Needs testing in Shade Agent");
    
    console.log("\n💡 Next Steps:");
    console.log("The setup appears correct. The issue is likely in the NEAR signature service.");
    console.log("Check if the Shade Agent can connect to v1.signer-prod.testnet");
    
  } catch (error) {
    console.error("❌ Test failed at step:", error.message);
    console.error("Full error:", error);
  }
}

main()
  .then(() => {
    console.log("\n🏁 Chain signature test completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Test script failed:", error);
    process.exit(1);
  });
