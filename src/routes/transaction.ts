import { Hono } from "hono";
import { requestSignature } from "@neardefi/shade-agent-js";
import {
  ethContractAbi,
  ethContractAddress,
  ethRpcUrl,
  Evm,
} from "../utils/ethereum";
import { getEthereumPriceUSD } from "../utils/fetch-eth-price";
import { Contract, JsonRpcProvider } from "ethers";
import { utils } from "chainsig.js";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors/appError";
import { handleRouteError } from "./errorHandling";
const { toRSV, uint8ArrayToHex } = utils.cryptography;

const log = createLogger("transaction");
const app = new Hono();
app.onError((err, c) => handleRouteError(c, err, log));

app.post("/", async (c) => {
  const contractId = process.env.NEXT_PUBLIC_contractId;
  if (!contractId) {
    throw new AppError("operation_failed", "Contract ID not configured");
  }

  // Get the ETH price
  const ethPrice = await getEthereumPriceUSD();
  if (!ethPrice) {
    throw new AppError("operation_failed", "Failed to fetch ETH price");
  }

  // Get the transaction and payload to sign
  const { transaction, hashesToSign } = await getPricePayload(
    ethPrice,
    contractId,
  );

  // Call the agent contract to get a signature for the payload
  const signRes = await requestSignature({
    path: "ethereum-1",
    payload: uint8ArrayToHex(hashesToSign[0]),
    keyType: "Ecdsa",
  });
  log.info("Signature response received", { hasSignature: !!signRes });

  // Reconstruct the signed transaction
  const signedTransaction = Evm.finalizeTransactionSigning({
    transaction,
    rsvSignatures: [toRSV(signRes)],
  });

  // Broadcast the signed transaction
  const txHash = await Evm.broadcastTx(signedTransaction);

  // Send back both the txHash and the new price optimistically
  return c.json({
    txHash: txHash.hash,
    newPrice: (ethPrice / 100).toFixed(2),
  });
});

async function getPricePayload(ethPrice: number, contractId: string) {
  // Derive the price pusher Ethereum address
  const { address: senderAddress } = await Evm.deriveAddressAndPublicKey(
    contractId,
    "ethereum-1",
  );
  // Create a new JSON-RPC provider for the Ethereum network
  const provider = new JsonRpcProvider(ethRpcUrl);
  // Create a new contract interface for the Ethereum Oracle contract
  const contract = new Contract(ethContractAddress, ethContractAbi, provider);
  // Encode the function data for the updatePrice function
  const data = contract.interface.encodeFunctionData("updatePrice", [ethPrice]);
  // Prepare the transaction for signing 
  const { transaction, hashesToSign } = await Evm.prepareTransactionForSigning({
    from: senderAddress,
    to: ethContractAddress,
    data,
  });

  return { transaction, hashesToSign };
}

export default app;
