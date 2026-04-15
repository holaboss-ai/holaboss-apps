import { createFileRoute } from "@tanstack/react-router"
import { listBookingsImpl } from "../../server/tools"

export const Route = createFileRoute("/api/upcoming-bookings")({
  server: {
    handlers: {
      GET: async () => {
        const r = await listBookingsImpl({ status: "upcoming", limit: 10 })
        if (r.ok) {
          return Response.json({ bookings: r.data.bookings })
        }
        return Response.json({ bookings: [], error: r.error.message })
      },
    },
  },
})