"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const hono_1 = require("hono");
const node_server_1 = require("@hono/node-server");
// Import routes
const ethAccount_1 = __importDefault(require("./routes/ethAccount"));
const agentAccount_1 = __importDefault(require("./routes/agentAccount"));
const transaction_1 = __importDefault(require("./routes/transaction"));
const app = new hono_1.Hono();
// Health check
app.get('/', (c) => c.json({ message: 'App is running' }));
// Routes
app.route('/api/eth-account', ethAccount_1.default);
app.route('/api/agent-account', agentAccount_1.default);
app.route('/api/transaction', transaction_1.default);
// Start the server
const port = Number(process.env.PORT || '3000');
console.log(`App is running on port ${port}`);
(0, node_server_1.serve)({ fetch: app.fetch, port });
//# sourceMappingURL=index.js.map