#!/usr/bin/env tsx
import { startMcpServer } from "./mcp.js"
import { startWorker } from "./queue.js"
import { startSyncScheduler } from "./sync-scheduler.js"

const MCP_PORT = Number(process.env.MCP_PORT ?? 3099)

startMcpServer(MCP_PORT)
startWorker()
startSyncScheduler()

console.log("[services] Gmail MCP server + worker + sync scheduler started")
