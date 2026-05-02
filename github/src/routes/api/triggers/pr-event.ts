import { createFileRoute } from "@tanstack/react-router"
import { getDb } from "@/server/db"

interface IncomingPayload {
  trigger_slug?: string
  trigger_id?: string
  received_at?: string
  data?: {
    action?: string
    pull_request?: {
      number?: number
      title?: string
      html_url?: string
      user?: { login?: string }
    }
    repository?: { full_name?: string }
  }
}

// Composio dispatches GITHUB_PULL_REQUEST_EVENT here. The in-sandbox
// runtime resolved this app + handler path from app.runtime.yaml's
// triggers: block. Body shape: `{ trigger_slug, trigger_id, received_at,
// data }` where `data` is the verbatim Composio payload for the slug.
export const Route = createFileRoute("/api/triggers/pr-event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: IncomingPayload
        try {
          body = (await request.json()) as IncomingPayload
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        if (!body.trigger_id) {
          return Response.json({ error: "missing trigger_id" }, { status: 400 })
        }

        const data = body.data ?? {}
        const pr = data.pull_request ?? {}
        const repo = data.repository?.full_name ?? "unknown"
        const prNumber = typeof pr.number === "number" ? pr.number : 0
        const action = data.action ?? "unknown"

        try {
          const db = getDb()
          db.prepare(
            `INSERT INTO github_pr_events (trigger_id, repo, pr_number, action, title, author, url, payload_json, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            body.trigger_id,
            repo,
            prNumber,
            action,
            pr.title ?? null,
            pr.user?.login ?? null,
            pr.html_url ?? null,
            JSON.stringify(data),
            body.received_at ?? new Date().toISOString(),
          )
        } catch (err) {
          return Response.json(
            {
              error: "db write failed",
              message: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }

        return Response.json({ accepted: true, repo, pr_number: prNumber, action })
      },
    },
  },
})
