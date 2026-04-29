import { useEffect, useMemo, useState } from "react"
import { Calendar } from "./ui/calendar"
import type { UpcomingBooking } from "../routes/api/upcoming-bookings"

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export function UpcomingBookings() {
  const [bookings, setBookings] = useState<UpcomingBooking[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Date>(() => startOfDay(new Date()))

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch("/api/upcoming-bookings")
        if (r.ok && !cancelled) {
          const data = (await r.json()) as { bookings: UpcomingBooking[]; error?: string }
          if (data.error) setError(data.error)
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

  const meetingDays = useMemo(() => {
    return bookings
      .map((b) => startOfDay(new Date(b.start_time)))
      .filter((d) => !Number.isNaN(d.getTime()))
  }, [bookings])

  const selectedBookings = useMemo(() => {
    return bookings.filter((b) => {
      const d = new Date(b.start_time)
      return !Number.isNaN(d.getTime()) && sameDay(d, selected)
    })
  }, [bookings, selected])

  return (
    <div className="border-b border-border px-6 py-5">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Upcoming · {bookings.length}
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid gap-6 md:grid-cols-[auto_1fr]">
          <Calendar
            mode="single"
            selected={selected}
            onSelect={(d) => d && setSelected(startOfDay(d))}
            modifiers={{ hasMeeting: meetingDays }}
            modifiersClassNames={{
              hasMeeting:
                "relative after:absolute after:bottom-1 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary",
            }}
          />

          <div>
            <div className="mb-2 text-xs text-muted-foreground">
              {selected.toLocaleDateString(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </div>
            {error && bookings.length === 0 && (
              <div className="text-xs text-destructive">{error}</div>
            )}
            {selectedBookings.length === 0 ? (
              <div className="text-xs text-muted-foreground">No meetings.</div>
            ) : (
              <ul className="divide-y divide-border">
                {selectedBookings.map((b) => {
                  const start = new Date(b.start_time)
                  const attendee =
                    b.attendees[0]?.name || b.attendees[0]?.email || "—"
                  return (
                    <li key={b.uid} className="flex items-baseline gap-3 py-2 text-sm">
                      <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                        {start.toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="flex-1 truncate text-foreground">{b.title}</span>
                      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                        {attendee}
                      </span>
                      {b.meeting_url && (
                        <a
                          href={b.meeting_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-xs text-primary hover:underline"
                        >
                          Join
                        </a>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
