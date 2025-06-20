import { getAgentAccount, getBalance } from '@neardefi/shade-agent-js';

export default async function handler(req, res) {
    try {
        const accountId = await getAgentAccount();
        console.log('Worker account:', accountId.workerAccountId);
        const balance = await getBalance(accountId.workerAccountId);
        console.log('Balance:', balance.available);
        res.status(200).json({ accountId: accountId.workerAccountId, balance: balance.available });
    } catch (error) {
        console.log('Error getting worker account:', error);
        res.status(500).json({ error: 'Failed to get worker account ' + error });
    }
} 