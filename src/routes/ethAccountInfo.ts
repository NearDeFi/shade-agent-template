import { Hono } from "hono";
import { Evm } from "../utils/ethereum";

const app = new Hono();

app.get("/", async (c) => {
  try {
    // Derive the price pusher EVM address
    const { address: senderAddress } = await Evm.deriveAddressAndPublicKey(
      process.env.AGENT_CONTRACT_ID as string,
      "ethereum-1",
    );

    // Get the balance of the EVM address
    const balanceResult = await Evm.getBalance(senderAddress);

    // Divide by decimals to get the balance in ETH
    const balance =
      Number(balanceResult.balance) / 10 ** balanceResult.decimals;

    return c.json({ senderAddress, balance });
  } catch (error) {
    console.log("Failed to get the derived EVM account info:", error);
    return c.json(
      { error: "Failed to get the derived EVM account info: " + error },
      500,
    );
  }
});

export default app;
