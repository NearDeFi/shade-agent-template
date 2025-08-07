const { chainAdapters, contracts } = require("chainsig.js");
const { createPublicClient, http } = require("viem");
const { Contract, JsonRpcProvider } = require("ethers");

async function main() {
  console.log("🧪 Simple IoTeX Integration Test");
  console.log("================================");
  
  const contractId = process.env.NEXT_PUBLIC_contractId || "ac.proxy.proudbear01.testnet";
  const contractAddress = "0xf3F4cb1D1775ab62c8f1CAAe3a5EE369D89DF910";
  
  try {
    // Step 1: Set up exactly like the working code
    const MPC_CONTRACT = new contracts.ChainSignatureContract({
      networkId: "testnet",
      contractId: "v1.signer-prod.testnet",
    });
    
    const iotexPublicClient = createPublicClient({
      transport: http("https://babel-api.testnet.iotex.io"),
    });
    
    const IoTeX = new chainAdapters.evm.EVM({
      publicClient: iotexPublicClient,
      contract: MPC_CONTRACT,
    });
    
    console.log("✅ IoTeX adapter created");
    
    // Step 2: Derive address
    const { address: senderAddress } = await IoTeX.deriveAddressAndPublicKey(
      contractId,
      "iotex-1",
    );
    console.log("✅ Derived address:", senderAddress);
    
    // Step 3: Check balance
    const balance = await IoTeX.getBalance(senderAddress);
    console.log("✅ Balance:", Number(balance.balance), "IOTX");
    
    // Step 4: Test contract read (should work)
    const provider = new JsonRpcProvider("https://babel-api.testnet.iotex.io");
    const abi = [
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
    
    const contract = new Contract(contractAddress, abi, provider);
    const currentPrice = await contract.getPrice();
    const owner = await contract.owner();
    
    console.log("✅ Contract read successful");
    console.log("  Current price:", currentPrice.toString());
    console.log("  Contract owner:", owner);
    console.log("  Expected owner:", senderAddress);
    console.log("  Ownership correct:", owner.toLowerCase() === senderAddress.toLowerCase());
    
    // Step 5: Test transaction preparation (this is where it might fail)
    console.log("\n🔧 Testing transaction preparation...");
    
    const updateAbi = [
      {
        inputs: [{ internalType: "uint256", name: "_price", type: "uint256" }],
        name: "updatePrice",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
    ];
    
    const updateContract = new Contract(contractAddress, updateAbi, provider);
    const testPrice = 12345;
    const data = updateContract.interface.encodeFunctionData("updatePrice", [testPrice]);
    
    console.log("✅ Function data encoded:", data);
    
    // This is where the issue likely occurs
    console.log("🔧 Attempting transaction preparation...");
    
    try {
      const result = await IoTeX.prepareTransactionForSigning({
        from: senderAddress,
        to: contractAddress,
        data,
      });
      console.log("✅ Transaction preparation successful!");
      console.log("  Transaction ready for signing");
      console.log("  Hashes to sign:", result.hashesToSign.length);
    } catch (error) {
      console.error("❌ Transaction preparation failed:", error.message);
      
      if (error.message.includes("Only owner can call this function")) {
        console.log("\n🔍 Analysis: The gas estimation is failing because:");
        console.log("1. The RPC doesn't know which address is calling (missing 'from' in gas estimation)");
        console.log("2. The contract correctly rejects calls from unknown addresses");
        console.log("3. This is a bug in the chainsig.js library's gas estimation");
        
        console.log("\n💡 Workaround needed:");
        console.log("- Use fixed gas limits instead of estimation");
        console.log("- Or modify the gas estimation call to include 'from' field");
      }
    }
    
  } catch (error) {
    console.error("❌ Test failed:", error.message);
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
