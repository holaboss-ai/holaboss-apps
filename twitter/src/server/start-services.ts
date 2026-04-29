#!/usr/bin/env tsx
import { startMcpServer } from "./mcp.js"
import { startMetricsScheduler } from "./metrics-scheduler.js"
import { startWorker } from "./queue.js"

const MCP_PORT = Number(process.env.MCP_PORT ?? 3099)

startMcpServer(MCP_PORT)
startWorker()
startMetricsScheduler()

console.log("[services] MCP server, worker, and metrics scheduler started")
