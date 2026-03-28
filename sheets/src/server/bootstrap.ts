import { startMcpServer } from "./mcp"

const MCP_PORT = Number(process.env.MCP_PORT ?? 3099)

let booted = false

export function bootstrapServices() {
  if (booted) return
  booted = true

  startMcpServer(MCP_PORT)

  console.log("[bootstrap] MCP server started")
}
