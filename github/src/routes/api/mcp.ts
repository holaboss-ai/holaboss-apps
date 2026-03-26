import { createFileRoute } from "@tanstack/react-router"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { getMcpServer } from "../../server/mcp"

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        const server = getMcpServer()
        await server.connect(transport)
        return transport.handleRequest(request)
      },
      POST: async ({ request }) => {
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        const server = getMcpServer()
        await server.connect(transport)
        return transport.handleRequest(request)
      },
    },
  },
})
