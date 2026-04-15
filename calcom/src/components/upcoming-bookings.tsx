import { useEffect, useState } from "react"
import type { BookingSummary } from "../lib/types"

export function UpcomingBookings() {
  const [bookings, setBookings] = useState<BookingSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch("/api/upcoming-bookings")
        if (r.ok && !cancelled) {
          const data = (await r.json()) as { bookings: BookingSummary[]; error?: string }
          if (data.error) {
            setError(data.error)
          }
          setBookings(data.bookings)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setError("Unable to load bookings")
          setLoading(false)
        }
      }
    }
    load()
    const interval = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (loading) {
    return (
      <div className="border-b border-border px-6 py-4 text-xs text-muted-foreground">
        Loading upcoming bookings…
      </div>
    )
  }

  if (error && bookings.length === 0) {
    return (
      <div className="border-b border-border px-6 py-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upcoming</div>
        <div className="mt-2 text-xs text-destructive">{error}</div>
      </div>
    )
  }

  if (bookings.length === 0) {
    return (
      <div className="border-b border-border px-6 py-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upcoming</div>
        <div className="mt-2 text-xs text-muted-foreground">No upcoming bookings.</div>
      </div>
    )
  }

  return (
    <div className="border-b border-border px-6 py-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Upcoming · {bookings.length}
      </div>
      <ul className="space-y-2">
        {bookings.slice(0, 5).map((b) => {
          const start = new Date(b.start_time)
          const attendeeName = b.attendees[0]?.name ?? b.attendees[0]?.email ?? "—"
          return (
            <li key={b.id} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-medium text-foreground">{b.title}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {start.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                with {attendeeName}
                {b.meeting_url && (
                  <>
                    {" · "}
                    <a href={b.meeting_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      Join
                    </a>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}