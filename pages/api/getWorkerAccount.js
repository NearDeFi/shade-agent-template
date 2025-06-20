import {getBalance, deriveWorkerAccount } from '@neardefi/shade-agent-js';

export default async function handler(req, res) {
    try {
        if (process.env.NEXT_PUBLIC_accountId !== undefined) {
            const balance = await getBalance(process.env.NEXT_PUBLIC_accountId);
            res.status(200).json({ accountId: process.env.NEXT_PUBLIC_accountId, balance: balance.available });
            return;
        }
      
        // Add this check to prevent TEE operations in local dev
        if (process.env.NODE_ENV !== 'production') {
            throw new Error('TEE operations only available in production');
        }
    
        const accountId = await deriveWorkerAccount();
        const balance = await getBalance(accountId);

        res.status(200).json({ accountId: accountId, balance: balance.available });
    } catch (error) {
        console.log('Error getting worker account:', error);
        res.status(500).json({ error: 'Failed to get worker account ' + error });
    }
} 