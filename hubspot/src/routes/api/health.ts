import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json({
          status: "ok",
          module: "hubspot",
          version: "1.0.0",
          timestamp: new Date().toISOString(),
        })
      },
    },
  },
})
