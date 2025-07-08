"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hono_1 = require("hono");
const ethereum_1 = require("../utils/ethereum");
const app = new hono_1.Hono();
app.get('/', async (c) => {
    // Fetch the environment variable inside the route
    const contractId = process.env.NEXT_PUBLIC_contractId;
    try {
        // Derive the price pusher Ethereum address
        const { address: senderAddress } = await ethereum_1.Evm.deriveAddressAndPublicKey(contractId, "ethereum-1");
        const balance = await ethereum_1.Evm.getBalance(senderAddress);
        return c.json({ senderAddress, balance: Number(balance.balance) });
    }
    catch (error) {
        console.log('Error getting the derived Ethereum address:', error);
        return c.json({ error: 'Failed to get the derived Ethereum address' }, 500);
    }
});
exports.default = app;
//# sourceMappingURL=ethAccount.js.map