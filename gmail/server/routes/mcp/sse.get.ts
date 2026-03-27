import { defineEventHandler } from "h3"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createMcpServer } from "../../../src/server/mcp"

const transports = new Map<string, SSEServerTransport>()

export { transports }

export default defineEventHandler(async (event) => {
  const res = event.node.res
  const transport = new SSEServerTransport("/mcp/messages", res)
  transports.set(transport.sessionId, transport)
  const server = createMcpServer()
  await server.connect(transport)
})
