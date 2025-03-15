import { deriveWorkerAccount } from '@neardefi/shade-agent-js';

export const dynamic = 'force-dynamic';

export default async function derive(req, res) {
    // use dev account when running locally
    if (process.env.NEXT_PUBLIC_accountId !== undefined) {
        res.status(200).json({
            accountId: process.env.NEXT_PUBLIC_accountId,
        });
        return;
    }
  
    // Add this check to prevent TEE operations in local dev
    if (process.env.NODE_ENV !== 'production') {
        throw new Error('TEE operations only available in production');
    }

    const accountId = await deriveWorkerAccount();

    res.status(200).json({
        accountId,
    });
}