import { createFileRoute } from "@tanstack/react-router"
import { clearActions } from "../../server/audit"

export const Route = createFileRoute("/api/clear-feed")({
  server: {
    handlers: {
      POST: async () => {
        const deleted = clearActions()
        return Response.json({ deleted })
      },
    },
  },
})