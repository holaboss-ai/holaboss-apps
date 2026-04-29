#!/usr/bin/env tsx
import { startMcpServer } from "./mcp.js"
import { startSyncScheduler } from "./sync-scheduler.js"

const MCP_PORT = Number(process.env.MCP_PORT ?? 3099)

startMcpServer(MCP_PORT)
startSyncScheduler()

console.log("[apollo] MCP server and sync scheduler started")
