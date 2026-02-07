#!/usr/bin/env node

/**
 * MCP Server Entry Point
 *
 * This file starts the Shade Agent as an MCP (Model Context Protocol) server,
 * allowing AI assistants to execute DeFi operations via standardized tools.
 *
 * Usage:
 *   npx tsx src/mcp/index.ts
 *
 * Or add to Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "shade-agent": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/shade-agent/src/mcp/index.ts"],
 *         "env": {
 *           "NEAR_ACCOUNT_ID": "...",
 *           "NEAR_SEED_PHRASE": "...",
 *           ...
 *         }
 *       }
 *     }
 *   }
 */

import "dotenv/config";
import { startMcpServer } from "./server";
import { createLogger } from "../utils/logger";

const log = createLogger("mcp");

startMcpServer().catch((error) => {
  log.error("Fatal error", { err: String(error) });
  process.exit(1);
});
