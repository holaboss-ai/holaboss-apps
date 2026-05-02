import { createFileRoute } from "@tanstack/react-router"
import { getDb } from "@/server/db"

interface IncomingPayload {
  trigger_slug?: string
  trigger_id?: string
  received_at?: string
  data?: {
    id?: string
    message_id?: string
    thread_id?: string
    sender?: string
    subject?: string
    message_text?: string
    label_ids?: unknown
    message_timestamp?: string
  }
}

// Composio dispatches GMAIL_NEW_GMAIL_MESSAGE here. Polling-backed
// (1-minute interval per app.runtime.yaml). Body shape:
// `{ trigger_slug, trigger_id, received_at, data }` where `data` is
// Composio's normalized Gmail payload (see toolkit docs).
export const Route = createFileRoute("/api/triggers/new-message")({
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
        const messageText = data.message_text ?? ""
        const previewText =
          messageText.length > 240 ? `${messageText.slice(0, 240)}…` : messageText

        try {
          const db = getDb()
          db.prepare(
            `INSERT INTO gmail_inbound_events
               (trigger_id, message_id, thread_id, sender, subject,
                preview_text, label_ids, message_at, payload_json, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            body.trigger_id,
            data.message_id ?? data.id ?? null,
            data.thread_id ?? null,
            data.sender ?? null,
            data.subject ?? null,
            previewText,
            Array.isArray(data.label_ids) ? JSON.stringify(data.label_ids) : null,
            data.message_timestamp ?? null,
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

        return Response.json({
          accepted: true,
          thread_id: data.thread_id ?? null,
          subject: data.subject ?? null,
        })
      },
    },
  },
})
