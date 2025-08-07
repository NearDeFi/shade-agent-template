const { ethers } = require("hardhat");

async function main() {
  console.log("Generating a new wallet for contract deployment...\n");
  
  // Generate a random wallet
  const wallet = ethers.Wallet.createRandom();
  
  console.log("=== New Wallet Generated ===");
  console.log("Address:", wallet.address);
  console.log("Private Key:", wallet.privateKey);
  console.log("Mnemonic:", wallet.mnemonic.phrase);
  
  console.log("\n=== Instructions ===");
  console.log("1. Copy the private key to your .env.development.local file:");
  console.log(`   PRIVATE_KEY=${wallet.privateKey}`);
  console.log("\n2. Fund this address with testnet IOTX tokens:");
  console.log("   - Visit: https://faucet.iotex.io/");
  console.log(`   - Send IOTX to: ${wallet.address}`);
  console.log("\n3. After funding, you can deploy the contract with:");
  console.log("   npx hardhat run scripts/deploy-iotex.js --network iotexTestnet");
  
  console.log("\n⚠️  SECURITY WARNING:");
  console.log("   - Keep your private key secure and never share it");
  console.log("   - This is for testnet use only");
  console.log("   - For mainnet, use a hardware wallet or other secure method");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
