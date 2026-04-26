import { useEffect, useState } from "react"

interface Status {
  connected: boolean
  error?: string
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
          const data = (await r.json()) as Status
          setStatus(data)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
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

  const frontendUrl = typeof window !== "undefined" ? window.location.origin : ""

  if (loading) {
    return (
      <div className="border-b border-border bg-muted/30 px-6 py-2 text-sm text-muted-foreground">
        Checking ZoomInfo connection…
      </div>
    )
  }

  if (status.error) {
    return (
      <div className="flex items-center justify-between border-b border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive">
        <span>Connection error: {status.error}</span>
        <a
          href={frontendUrl}
          className="underline hover:text-destructive-foreground"
        >
          Retry →
        </a>
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="flex items-center justify-between border-b border-amber-500/40 bg-amber-500/10 px-6 py-2 text-sm">
        <span className="text-amber-700 dark:text-amber-400">
          Not connected. Open Holaboss to connect ZoomInfo.
        </span>
        <a
          href={frontendUrl}
          className="text-amber-700 dark:text-amber-400 underline hover:text-foreground"
        >
          Connect ZoomInfo →
        </a>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-6 py-2 text-sm">
      <span className="flex items-center gap-2 text-foreground">
        <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
        Connected to ZoomInfo
      </span>
      <a
        href="https://app.zoominfo.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-foreground"
      >
        Open ZoomInfo →
      </a>
    </div>
  )
}
