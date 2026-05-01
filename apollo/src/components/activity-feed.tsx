import { ChevronRight, ExternalLink } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import type { AgentActionRecord } from "@/lib/types"

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

  return (
    <section>
      <header className="flex items-baseline justify-between pb-2">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          Activity
        </h2>
        {actions.length > 0 ? (
          <Button variant="ghost" size="xs" onClick={clearFeed}>
            {confirming ? "Confirm" : "Clear"}
          </Button>
        ) : null}
      </header>

      {actions.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
          No agent activity yet. Ask your agent to search Apollo for prospects.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {actions.map((a) => {
            const isError = a.outcome !== "success"
            const open = expanded[a.id]
            return (
              <li key={a.id} className="py-3">
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                      isError ? "bg-destructive/85" : "bg-emerald-500/85 dark:bg-emerald-400/85"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-mono text-xs text-foreground">
                        {a.tool_name}
                      </span>
                      <span
                        className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                        title={new Date(a.timestamp).toLocaleString()}
                      >
                        {formatSmartTime(a.timestamp)}
                      </span>
                    </div>
                    {a.result_summary ? (
                      <p
                        className={`mt-0.5 text-xs leading-relaxed ${
                          isError ? "text-destructive" : "text-muted-foreground"
                        }`}
                      >
                        {a.result_summary}
                      </p>
                    ) : null}
                    {isError && a.error_code ? (
                      <p className="mt-0.5 text-xs text-destructive">
                        <span className="font-mono">{a.error_code}</span>
                        {a.error_message ? <span className="ml-2">{a.error_message}</span> : null}
                      </p>
                    ) : null}
                    <div className="mt-1.5 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setExpanded((p) => ({ ...p, [a.id]: !open }))}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronRight
                          className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
                        />
                        args
                      </button>
                      {a.apollo_deep_link ? (
                        <a
                          href={a.apollo_deep_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                        >
                          Open in Apollo
                          <ExternalLink className="size-3" />
                        </a>
                      ) : null}
                    </div>
                    {open ? (
                      <pre className="mt-2 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/85">
                        {prettyArgs(a.args_json)}
                      </pre>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function prettyArgs(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

// Notion-style relative-for-recent + abbreviated-absolute. Hover the cell
// for the full ISO via the title attribute.
function formatSmartTime(ts: string | number | Date): string {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return ""
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  }
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
  }
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" })
}
