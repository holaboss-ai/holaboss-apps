import { useEffect, useState } from "react"
import type { AgentActionRecord } from "../lib/types"

interface Props {
  initial: AgentActionRecord[]
}

export function ActivityFeed({ initial }: Props) {
  const [actions, setActions] = useState<AgentActionRecord[]>(initial)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch("/api/recent-actions?limit=100")
        if (r.ok && !cancelled) {
          const data = (await r.json()) as { actions: AgentActionRecord[] }
          setActions(data.actions)
        }
      } catch {
        /* ignore */
      }
    }
    const interval = setInterval(poll, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  async function clearFeed() {
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 3000)
      return
    }
    await fetch("/api/clear-feed", { method: "POST" })
    setActions([])
    setConfirming(false)
  }

  if (actions.length === 0) {
    return (
      <div className="px-6 py-12 text-center text-sm text-muted-foreground">
        No agent activity yet. Ask your agent to search Apollo for prospects.
      </div>
    )
  }

  return (
    <div className="px-6 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Activity
        </h2>
        <button
          type="button"
          onClick={clearFeed}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          {confirming ? "Click again to confirm" : "Clear feed"}
        </button>
      </div>
      <ul className="space-y-3">
        {actions.map((a) => (
          <li
            key={a.id}
            className={`rounded-md border px-4 py-3 text-sm ${
              a.outcome === "error"
                ? "border-destructive/40 bg-destructive/5"
                : "border-border bg-card"
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                    a.outcome === "success"
                      ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                      : "bg-destructive/20 text-destructive"
                  }`}
                  aria-hidden
                >
                  {a.outcome === "success" ? "✓" : "✗"}
                </span>
                <div className="flex-1">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(a.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="font-mono text-xs text-foreground">{a.tool_name}</span>
                  </div>
                  {a.result_summary && (
                    <div className="mt-1 text-foreground">{a.result_summary}</div>
                  )}
                  {a.error_code && (
                    <div className="mt-1 text-destructive">
                      <span className="font-mono text-xs">{a.error_code}</span>
                      {a.error_message && <span className="ml-2">{a.error_message}</span>}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [a.id]: !prev[a.id] }))
                    }
                    className="mt-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {expanded[a.id] ? "▾" : "▸"} args
                  </button>
                  {expanded[a.id] && (
                    <pre className="mt-2 overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
                      {JSON.stringify(JSON.parse(a.args_json), null, 2)}
                    </pre>
                  )}
                </div>
              </div>
              {a.apollo_deep_link && (
                <a
                  href={a.apollo_deep_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-primary hover:underline"
                >
                  Open in Apollo →
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
