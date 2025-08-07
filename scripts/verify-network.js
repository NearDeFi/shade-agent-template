const hre = require("hardhat");

async function main() {
  console.log("Verifying IoTeX testnet connection...");
  console.log("Network:", hre.network.name);
  console.log("Network Config:", hre.network.config);
  
  try {
    // Get network info
    const provider = hre.ethers.provider;
    const network = await provider.getNetwork();
    
    console.log("\n=== Network Information ===");
    console.log("Chain ID:", network.chainId.toString());
    console.log("Network Name:", network.name);
    
    // Get latest block
    const blockNumber = await provider.getBlockNumber();
    console.log("Latest Block:", blockNumber);
    
    // Get block details
    const block = await provider.getBlock(blockNumber);
    console.log("Block Timestamp:", new Date(block.timestamp * 1000).toISOString());
    
    // Verify this is IoTeX testnet
    if (network.chainId === 4690n) {
      console.log("✅ Connected to IoTeX Testnet (Chain ID: 4690)");
    } else {
      console.log("❌ Wrong network! Expected Chain ID 4690, got:", network.chainId.toString());
    }
    
    // Check if wallet is configured
    if (process.env.PRIVATE_KEY) {
      const wallet = new hre.ethers.Wallet(process.env.PRIVATE_KEY, provider);
      console.log("\n=== Wallet Information ===");
      console.log("Wallet Address:", wallet.address);
      
      const balance = await provider.getBalance(wallet.address);
      console.log("Balance:", hre.ethers.formatEther(balance), "IOTX");
      
      // Check transaction count (nonce)
      const nonce = await provider.getTransactionCount(wallet.address);
      console.log("Transaction Count (Nonce):", nonce);
      
      if (nonce > 0) {
        console.log("ℹ️  This wallet has been used before");
      } else {
        console.log("ℹ️  This is a fresh wallet (no transactions)");
      }
    } else {
      console.log("⚠️  PRIVATE_KEY not set");
    }
    
  } catch (error) {
    console.error("❌ Error connecting to network:", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Script failed:", error);
    process.exit(1);
  });
