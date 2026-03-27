#!/usr/bin/env tsx
import { startMcpServer } from "./mcp.js"

const MCP_PORT = Number(process.env.MCP_PORT ?? 3099)

startMcpServer(MCP_PORT)

console.log("[services] Gmail MCP server started")
