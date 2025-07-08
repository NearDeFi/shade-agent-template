import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import dotenv from 'dotenv';

// Load environment variables from .env file (only needed for local development)
if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

// Import routes
import ethAccount from './routes/ethAccount';
import agentAccount from './routes/agentAccount';
import transaction from './routes/transaction';

const app = new Hono();

// Health check
app.get('/', (c) => c.json({ message: 'App is running' }));

// Routes
app.route('/api/eth-account', ethAccount);
app.route('/api/agent-account', agentAccount);
app.route('/api/transaction', transaction);

// Start the server
const port = Number(process.env.PORT || '3000');

console.log(`App is running on port ${port}`);

serve({ fetch: app.fetch, port }); 