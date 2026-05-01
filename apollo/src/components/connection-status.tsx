import { ExternalLink } from "lucide-react"
import { useEffect, useState } from "react"

import { Badge } from "@/components/ui/badge"

interface Status {
  connected: boolean
  user_email?: string
  team_name?: string
  is_master_key?: boolean
  error?: string
}

type State =
  | { kind: "loading" }
  | { kind: "connected"; status: Status }
  | { kind: "disconnected"; status: Status }
  | { kind: "error"; message: string }

function useConnectionStatus(): State {
  const [state, setState] = useState<State>({ kind: "loading" })
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch("/api/connection-status")
        if (!r.ok || cancelled) return
        const status = (await r.json()) as Status
        if (cancelled) return
        if (status.error) {
          setState({ kind: "error", message: status.error })
        } else if (status.connected) {
          setState({ kind: "connected", status })
        } else {
          setState({ kind: "disconnected", status })
        }
      } catch {
        /* ignore */
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
  return state
}

export function ConnectionBadge() {
  const state = useConnectionStatus()
  if (state.kind === "loading") {
    return <Badge variant="outline">Checking…</Badge>
  }
  if (state.kind === "connected") {
    return (
      <Badge variant="success">
        <span aria-hidden className="size-1.5 rounded-full bg-emerald-500/85 dark:bg-emerald-400/85" />
        Connected
      </Badge>
    )
  }
  if (state.kind === "error") {
    return <Badge variant="destructive">Error</Badge>
  }
  return <Badge variant="warning">Not connected</Badge>
}

export function ConnectionAlert() {
  const state = useConnectionStatus()
  const frontendUrl = typeof window !== "undefined" ? window.location.origin : ""
  if (state.kind === "loading" || state.kind === "connected") return null
  if (state.kind === "error") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <span>Connection error: {state.message}</span>
        <a href={frontendUrl} className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
          Retry
          <ExternalLink className="size-3" />
        </a>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <span>Not connected. Open Holaboss to connect Apollo.</span>
      <a href={frontendUrl} className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
        Connect
        <ExternalLink className="size-3" />
      </a>
    </div>
  )
}
