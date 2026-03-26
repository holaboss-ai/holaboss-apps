#!/usr/bin/env tsx
import { startMcpServer } from "./mcp.js"
const PORT = Number(process.env.MCP_PORT ?? process.env.PORT ?? 3099)
startMcpServer(PORT)
