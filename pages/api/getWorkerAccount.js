import {getBalance, deriveAgentAccount } from '@neardefi/shade-agent-js';

export default async function handler(req, res) {
    try {
        if (process.env.NODE_ENV !== 'production') {
            const balance = await getBalance(process.env.NEAR_ACCOUNT_ID);
            res.status(200).json({ accountId: process.env.NEAR_ACCOUNT_ID, balance: balance.available });
            return;
        }

        const accountId = await deriveAgentAccount();
        const balance = await getBalance(accountId);
        
        res.status(200).json({ accountId: accountId, balance: balance.available });
    } catch (error) {
        console.log('Error getting worker account:', error);
        res.status(500).json({ error: 'Failed to get worker account ' + error });
    }
} 