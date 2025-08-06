import { Hono } from "hono";
import { getIoTeXAdapter, getIoTeXPath } from "../utils/iotex";

const app = new Hono();

app.get("/", async (c) => {
  const contractId = process.env.NEXT_PUBLIC_contractId;
  const network = (c.req.query("network") as 'testnet' | 'mainnet') || 'testnet';
  
  try {
    // Get the appropriate IoTeX adapter and path
    const IoTeXAdapter = getIoTeXAdapter(network);
    const iotexPath = getIoTeXPath(network);
    
    // Derive the IoTeX address
    const { address: senderAddress } = await IoTeXAdapter.deriveAddressAndPublicKey(
      contractId,
      iotexPath,
    );

    // Get the balance of the address
    const balance = await IoTeXAdapter.getBalance(senderAddress);
    
    return c.json({ 
      senderAddress, 
      balance: Number(balance.balance),
      network,
      chainId: network === 'testnet' ? 4690 : 4689
    });
  } catch (error) {
    console.log("Error getting the derived IoTeX address:", error);
    return c.json({ 
      error: "Failed to get the derived IoTeX address",
      network,
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

export default app; 