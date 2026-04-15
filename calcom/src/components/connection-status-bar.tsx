import { useEffect, useState } from "react"

interface Status {
  connected: boolean
  event_types_count?: number
  error?: string
  frontendUrl?: string
}

export function ConnectionStatusBar() {
  const [status, setStatus] = useState<Status>({ connected: false })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch("/api/connection-status")
        if (r.ok && !cancelled) {
          setStatus((await r.json()) as Status)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setStatus({ connected: false, error: "Unable to reach server" })
          setLoading(false)
        }
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    const onFocus = () => poll()
    window.addEventListener("focus", onFocus)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener("focus", onFocus)
    }
  }, [])

  const connectUrl = status.frontendUrl || window.location.origin

  if (loading) {
    return (
      <div className="border-b border-border bg-muted/30 px-6 py-2 text-sm text-muted-foreground">
        Checking Cal.com connection…
      </div>
    )
  }

  if (status.error) {
    return (
      <div className="flex items-center justify-between border-b border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive">
        <span>Connection error: {status.error}</span>
        <a href={connectUrl} className="underline hover:text-destructive-foreground">Retry →</a>
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="flex items-center justify-between border-b border-amber-500/40 bg-amber-500/10 px-6 py-2 text-sm">
        <span className="text-amber-700 dark:text-amber-400">
          Not connected. Open Holaboss to connect Cal.com.
        </span>
        <a href={connectUrl} className="text-amber-700 dark:text-amber-400 underline hover:text-foreground">
          Connect Cal.com →
        </a>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-6 py-2 text-sm">
      <span className="flex items-center gap-2 text-foreground">
        <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
        Connected to Cal.com
        {typeof status.event_types_count === "number" && status.event_types_count > 0
          ? ` · ${status.event_types_count} event type${status.event_types_count === 1 ? "" : "s"}`
          : ""}
      </span>
      <a
        href="https://app.cal.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-foreground"
      >
        Open Cal.com →
      </a>
    </div>
  )
}