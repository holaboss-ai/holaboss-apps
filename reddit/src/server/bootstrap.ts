import { startMcpServer } from "./mcp"
import { startWorker } from "./queue"

const MCP_PORT = Number(process.env.MCP_PORT ?? 3099)

let booted = false

export function bootstrapServices() {
  if (booted) return
  booted = true

  // Start MCP server on separate port
  startMcpServer(MCP_PORT)

  // Start BullMQ worker (in-process)
  startWorker()

  console.log("[bootstrap] MCP server and worker started")
}
