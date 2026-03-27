import { createFileRoute } from "@tanstack/react-router"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { createMcpServer } from "../../server/mcp"

async function handleMcp(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const server = createMcpServer()
  await server.connect(transport)
  return transport.handleRequest(request)
}

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: async ({ request }) => handleMcp(request),
      POST: async ({ request }) => handleMcp(request),
    },
  },
})
