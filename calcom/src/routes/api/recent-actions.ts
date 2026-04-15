import { createFileRoute } from "@tanstack/react-router"
import { listRecentActions } from "../../server/audit"

export const Route = createFileRoute("/api/recent-actions")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const since = url.searchParams.get("since") ?? undefined
        const limit = Number(url.searchParams.get("limit") ?? 100)
        const actions = listRecentActions({ since, limit })
        return Response.json({ actions })
      },
    },
  },
})