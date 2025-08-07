import { Hono } from "hono";
import { requestSignature } from "@neardefi/shade-agent-js";
import {
  iotexContractAddress,
  iotexRpcUrl,
  iotexContractAbi,
  IoTeX,
} from "../utils/iotex";
import { getEthereumPriceUSD } from "../utils/fetch-eth-price";
import { Contract, JsonRpcProvider } from "ethers";
import { utils } from "chainsig.js";
const { toRSV, uint8ArrayToHex } = utils.cryptography;

const app = new Hono();

app.get("/", async (c) => {
  try {
    console.log("🚀 Starting IoTeX transaction");
    
    const contractId = process.env.NEXT_PUBLIC_contractId;
    if (!contractId) {
      console.log("❌ Contract ID not configured");
      return c.json({ error: "Contract ID not configured" }, 500);
    }
    console.log("✅ Contract ID:", contractId);

    // Get the ETH price (reusing the same price feed)
    console.log("📊 Fetching ETH price...");
    const ethPrice = await getEthereumPriceUSD();
    if (!ethPrice) {
      console.log("❌ Failed to fetch ETH price");
      return c.json({ error: "Failed to fetch ETH price" }, 500);
    }
    console.log("✅ ETH price:", ethPrice);

    // Get the transaction and payload to sign
    console.log("🔧 Preparing transaction for signing...");
    const { transaction, hashesToSign } = await getIoTeXPricePayload(
      ethPrice,
      contractId,
    );
    console.log("✅ Transaction prepared, hashes to sign:", hashesToSign.length);

    // Call the agent contract to get a signature for the payload
    console.log("🖋️  Requesting signature from NEAR...");
    const signRes = await requestSignature({
      path: "iotex-1",
      payload: uint8ArrayToHex(hashesToSign[0]),
    });
    console.log("✅ Signature received:", signRes);

    // Reconstruct the signed transaction
    console.log("🔧 Finalizing transaction signing...");
    const signedTransaction = IoTeX.finalizeTransactionSigning({
      transaction,
      rsvSignatures: [toRSV(signRes)],
    });
    console.log("✅ Transaction signed");

    // Broadcast the signed transaction
    console.log("📡 Broadcasting transaction...");
    const txHash = await IoTeX.broadcastTx(signedTransaction);
    console.log("✅ Transaction broadcasted:", txHash.hash);

    return c.json({
      txHash: txHash.hash,
      newPrice: (ethPrice / 100).toFixed(2),
      success: true,
    });
  } catch (error) {
    console.error("❌ IoTeX transaction failed at step:", error.message);
    console.error("Full error:", error);
    return c.json({ 
      error: "Failed to send the IoTeX transaction",
      details: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
});

async function getIoTeXPricePayload(ethPrice: number, contractId: string) {
  console.log("  📋 Getting IoTeX price payload...");
  
  // Derive the IoTeX address (exactly like Ethereum)
  console.log("  🔑 Deriving IoTeX address...");
  const { address: senderAddress } = await IoTeX.deriveAddressAndPublicKey(
    contractId,
    "iotex-1",
  );
  console.log("  ✅ Sender address:", senderAddress);
  
  // Create a new JSON-RPC provider for the IoTeX network
  const provider = new JsonRpcProvider(iotexRpcUrl);
  
  // Create a new contract interface for the IoTeX Oracle contract
  const contract = new Contract(iotexContractAddress, iotexContractAbi, provider);
  
  // Encode the function data for the updatePrice function
  console.log("  📝 Encoding function data...");
  const data = contract.interface.encodeFunctionData("updatePrice", [ethPrice]);
  console.log("  ✅ Function data:", data);
  
  // Prepare the transaction for signing (exactly like Ethereum)
  console.log("  🔧 Preparing transaction for signing...");
  const result = await IoTeX.prepareTransactionForSigning({
    from: senderAddress,
    to: iotexContractAddress,
    data,
  });
  console.log("  ✅ Transaction preparation successful");

  return result;
}

export default app; 