import { createFileRoute } from "@tanstack/react-router"
import { getConnectionStatus } from "../../server/connection"

export const Route = createFileRoute("/api/connection-status")({
  server: {
    handlers: {
      GET: async () => {
        const status = await getConnectionStatus()
        return Response.json(status)
      },
    },
  },
})