import { registerAgent } from '@neardefi/shade-agent-js';

export const dynamic = 'force-dynamic';

export default async function register(req, res) {
    if (process.env.NEXT_PUBLIC_accountId !== undefined) {
        // cannot register worker when running locally
        console.log('cannot register while running locally');
        return;
    }

    const registered = await registerAgent();

    res.status(200).json({ registered });
}
