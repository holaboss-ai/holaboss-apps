import { createFileRoute } from "@tanstack/react-router"
import { getDb } from "../../server/db"

interface MirrorBookingRow {
  uid: string
  title: string | null
  status: string | null
  start_time: string | null
  end_time: string | null
  attendees_json: string | null
  meeting_url: string | null
}

export interface UpcomingBooking {
  uid: string
  title: string
  status: string | null
  start_time: string
  end_time: string | null
  attendees: Array<{ name: string; email: string }>
  meeting_url: string | null
}

export const Route = createFileRoute("/api/upcoming-bookings")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const db = getDb()
          // Read from the locally synced mirror so the UI doesn't pay
          // an upstream Cal.com round-trip on each refresh. Window:
          // ~14 days ahead is what fits in a month-view calendar.
          const rows = db
            .prepare(
              `SELECT uid, title, status, start_time, end_time, attendees_json, meeting_url
               FROM calcom_bookings
               WHERE status NOT IN ('cancelled', 'rejected')
                 AND start_time IS NOT NULL
                 AND start_time >= datetime('now', '-1 day')
                 AND start_time <= datetime('now', '+60 days')
               ORDER BY start_time ASC`,
            )
            .all() as MirrorBookingRow[]
          const bookings: UpcomingBooking[] = rows.map((r) => ({
            uid: r.uid,
            title: r.title ?? "(untitled)",
            status: r.status,
            start_time: r.start_time as string,
            end_time: r.end_time,
            attendees: parseAttendees(r.attendees_json),
            meeting_url: r.meeting_url,
          }))
          return Response.json({ bookings })
        } catch (e) {
          return Response.json({
            bookings: [],
            error: e instanceof Error ? e.message : String(e),
          })
        }
      },
    },
  },
})

function parseAttendees(json: string | null): Array<{ name: string; email: string }> {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>
    return parsed.map((a) => ({
      name: typeof a.name === "string" ? a.name : "",
      email: typeof a.email === "string" ? a.email : "",
    }))
  } catch {
    return []
  }
}
