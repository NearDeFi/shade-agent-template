"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hono_1 = require("hono");
const shade_agent_js_1 = require("@neardefi/shade-agent-js");
const app = new hono_1.Hono();
app.get('/', async (c) => {
    try {
        const accountId = await (0, shade_agent_js_1.getAgentAccount)();
        const balance = await (0, shade_agent_js_1.getBalance)(accountId.workerAccountId);
        return c.json({ accountId: accountId.workerAccountId, balance: balance.available });
    }
    catch (error) {
        console.log('Error getting worker account:', error);
        return c.json({ error: 'Failed to get worker account ' + error }, 500);
    }
});
exports.default = app;
//# sourceMappingURL=agentAccount.js.map