import { Hono } from "hono";
import { requestSignature } from "@neardefi/shade-agent-js";
import {
  iotexContractAddress,
  getIoTeXAdapter,
  getIoTeXPath,
} from "../utils/iotex";
import { ethContractAbi } from "../utils/ethereum";
import { getEthereumPriceUSD } from "../utils/fetch-eth-price";
import { Contract, JsonRpcProvider } from "ethers";
import { utils } from "chainsig.js";
const { toRSV, uint8ArrayToHex } = utils.cryptography;

const app = new Hono();

app.get("/", async (c) => {
  try {
    const contractId = process.env.NEXT_PUBLIC_contractId;
    const network = (c.req.query("network") as 'testnet' | 'mainnet') || 'testnet';
    
    if (!contractId) {
      return c.json({ error: "Contract ID not configured" }, 500);
    }

    // Get the ETH price (or IOTX price)
    const ethPrice = await getEthereumPriceUSD();
    if (!ethPrice) {
      return c.json({ error: "Failed to fetch ETH price" }, 500);
    }

    // Get the appropriate IoTeX adapter and path
    const IoTeXAdapter = getIoTeXAdapter(network);
    const iotexPath = getIoTeXPath(network);

    // Get the transaction and payload to sign
    const { transaction, hashesToSign } = await getIoTeXPricePayload(
      ethPrice,
      contractId,
      network,
    );

    // Call the agent contract to get a signature for the payload
    const signRes = await requestSignature({
      path: iotexPath,
      payload: uint8ArrayToHex(hashesToSign[0]),
    });
    console.log("signRes", signRes);

    // Reconstruct the signed transaction
    const signedTransaction = IoTeXAdapter.finalizeTransactionSigning({
      transaction,
      rsvSignatures: [toRSV(signRes)],
    });

    // Broadcast the signed transaction
    const txHash = await IoTeXAdapter.broadcastTx(signedTransaction);

    return c.json({
      txHash: txHash.hash,
      newPrice: (ethPrice / 100).toFixed(2),
      network,
      chainId: network === 'testnet' ? 4690 : 4689
    });
  } catch (error) {
    console.error("Failed to send the IoTeX transaction:", error);
    return c.json({ 
      error: "Failed to send the IoTeX transaction",
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

async function getIoTeXPricePayload(ethPrice: number, contractId: string, network: 'testnet' | 'mainnet') {
  // Get the appropriate IoTeX adapter and configuration
  const IoTeXAdapter = getIoTeXAdapter(network);
  const iotexConfig = network === 'testnet' 
    ? { rpcUrl: "https://babel-api.testnet.iotex.io", contractAddress: iotexContractAddress }
    : { rpcUrl: "https://babel-api.mainnet.iotex.io", contractAddress: iotexContractAddress };
  
  // Derive the IoTeX address
  const { address: senderAddress } = await IoTeXAdapter.deriveAddressAndPublicKey(
    contractId,
    network === 'testnet' ? "iotex-1" : "iotex-mainnet",
  );
  
  // Create a new JSON-RPC provider for IoTeX
  const provider = new JsonRpcProvider(iotexConfig.rpcUrl);
  
  // Create a new contract interface for the IoTeX Oracle contract
  const contract = new Contract(iotexConfig.contractAddress, ethContractAbi, provider);
  
  // Encode the function data for the updatePrice function
  const data = contract.interface.encodeFunctionData("updatePrice", [ethPrice]);
  
  // Prepare the transaction for signing 
  const { transaction, hashesToSign } = await IoTeXAdapter.prepareTransactionForSigning({
    from: senderAddress,
    to: iotexConfig.contractAddress,
    data,
  });

  return { transaction, hashesToSign };
}

export default app; 