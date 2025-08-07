const hre = require("hardhat");

async function main() {
  console.log("💸 Transferring IOTX to proudbear01.testnet derived address");
  console.log("========================================================");
  
  const fromAddress = "0x8D45053985C684D4AD9982e04Bc668AD6F83b2B6"; // Original funded wallet
  const toAddress = "0x3a9847f0375e7372a1D7420E7B9B74F490Ae198a";   // proudbear01.testnet derived
  const transferAmount = hre.ethers.parseEther("1.0"); // Transfer 1 IOTX (plenty for gas fees)
  
  // Create wallet from private key
  const wallet = new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider);
  
  console.log("📋 Transfer Details:");
  console.log("  From (Original Wallet):", fromAddress);
  console.log("  To (proudbear01.testnet):", toAddress);
  console.log("  Amount:", hre.ethers.formatEther(transferAmount), "IOTX");
  console.log("  Network:", hre.network.name);
  
  // Check balances before transfer
  const fromBalance = await hre.ethers.provider.getBalance(fromAddress);
  const toBalance = await hre.ethers.provider.getBalance(toAddress);
  
  console.log("\n💰 Balances Before Transfer:");
  console.log("  From Address:", hre.ethers.formatEther(fromBalance), "IOTX");
  console.log("  To Address:", hre.ethers.formatEther(toBalance), "IOTX");
  
  // Check if we have enough balance
  if (fromBalance < transferAmount) {
    console.log("❌ Insufficient balance for transfer");
    console.log("Need:", hre.ethers.formatEther(transferAmount), "IOTX");
    console.log("Have:", hre.ethers.formatEther(fromBalance), "IOTX");
    process.exit(1);
  }
  
  // Estimate gas for the transfer
  const gasEstimate = await hre.ethers.provider.estimateGas({
    from: fromAddress,
    to: toAddress,
    value: transferAmount,
  });
  
  const gasPrice = await hre.ethers.provider.getFeeData();
  const gasCost = gasEstimate * gasPrice.gasPrice;
  
  console.log("\n⛽ Gas Estimation:");
  console.log("  Gas Limit:", gasEstimate.toString());
  console.log("  Gas Price:", hre.ethers.formatUnits(gasPrice.gasPrice, "gwei"), "gwei");
  console.log("  Gas Cost:", hre.ethers.formatEther(gasCost), "IOTX");
  
  // Execute the transfer
  console.log("\n🚀 Executing transfer...");
  const tx = await wallet.sendTransaction({
    to: toAddress,
    value: transferAmount,
    gasLimit: gasEstimate,
    gasPrice: gasPrice.gasPrice,
  });
  
  console.log("Transaction submitted:", tx.hash);
  console.log("Waiting for confirmation...");
  
  // Wait for confirmation
  const receipt = await tx.wait();
  console.log("✅ Transaction confirmed in block:", receipt.blockNumber);
  
  // Check balances after transfer
  const fromBalanceAfter = await hre.ethers.provider.getBalance(fromAddress);
  const toBalanceAfter = await hre.ethers.provider.getBalance(toAddress);
  
  console.log("\n💰 Balances After Transfer:");
  console.log("  From Address:", hre.ethers.formatEther(fromBalanceAfter), "IOTX");
  console.log("  To Address:", hre.ethers.formatEther(toBalanceAfter), "IOTX");
  
  console.log("\n=== Transfer Summary ===");
  console.log("From:", fromAddress);
  console.log("To:", toAddress);
  console.log("Amount:", hre.ethers.formatEther(transferAmount), "IOTX");
  console.log("Gas Used:", receipt.gasUsed.toString());
  console.log("Transaction Hash:", tx.hash);
  console.log("Explorer:", `https://testnet.iotexscan.io/tx/${tx.hash}`);
  
  console.log("\n🎉 Transfer completed successfully!");
  console.log("The proudbear01.testnet derived address now has IOTX for gas fees");
  console.log("Ready to test the Shade Agent IoTeX integration!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Transfer failed:", error);
    process.exit(1);
  });
