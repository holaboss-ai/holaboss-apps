import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import type { DraftRecord } from "../lib/types"
import { MODULE_CONFIG } from "../lib/types"
import { syncDraftOutput, syncThreadOutput } from "./app-outputs"
import { getDb } from "./db"
import { listThreads, getThread, parseMessage } from "./google-api"
import { enqueueSend } from "./queue"
import { resolveHolabossTurnContext } from "./holaboss-bridge"

function text(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] } }
function err(message: string) { return { content: [{ type: "text" as const, text: message }], isError: true } }

function extractEmailAddress(value: string): string {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match?.[0] ?? ""
}

function firstNonEmpty(values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = (value ?? "").trim()
    if (normalized) {
      return normalized
    }
  }
  return ""
}

function persistDraftOutputId(db: ReturnType<typeof getDb>, draftId: string, outputId: string) {
  db.prepare("UPDATE drafts SET output_id = ? WHERE id = ?").run(outputId, draftId)
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: `${MODULE_CONFIG.name} Module`,
    version: "1.0.0",
  })

  server.tool("gmail_search", "Search Gmail threads by query string (from:X, to:X, subject:X, or free text)", {
    query: z.string().describe("Gmail search query (e.g. 'from:alice subject:meeting')"),
    max_results: z.number().optional().describe("Max results, default 10"),
  }, async ({ query, max_results }) => {
    try {
      const threads = await listThreads(query, max_results ?? 10)
      return text(threads)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_get_thread", "Read a full Gmail thread with all messages", {
    thread_id: z.string().describe("Gmail thread ID"),
  }, async ({ thread_id }) => {
    try {
      const thread = await getThread(thread_id)
      const messages = thread.messages.map(parseMessage)
      return text({ id: thread.id, messages })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_open_thread", "Open a Gmail thread as a durable workspace output for CRM follow-up.", {
    thread_id: z.string().describe("Gmail thread ID"),
    contact_email: z.string().optional().describe("Primary CRM contact email for the thread"),
    contact_row_ref: z.string().optional().describe("Optional Sheets contact row reference for CRM linking"),
  }, async ({ thread_id, contact_email, contact_row_ref }) => {
    try {
      const thread = await getThread(thread_id)
      const messages = thread.messages.map(parseMessage)
      const primaryEmail = firstNonEmpty([
        contact_email,
        ...messages.flatMap((message) => [
          extractEmailAddress(message.to),
          extractEmailAddress(message.from),
        ]),
      ])
      const subject = firstNonEmpty(messages.map((message) => message.subject))
      const outputId = await syncThreadOutput({
        threadId: thread.id,
        subject,
        primaryEmail: primaryEmail || null,
        contactRowRef: contact_row_ref ?? null,
      })

      return text({
        id: thread.id,
        subject,
        primary_email: primaryEmail || null,
        output_id: outputId,
        messages,
      })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_draft_reply", "Create an email draft (stored locally, NOT sent). Use gmail_send_draft to send.", {
    to_email: z.string().describe("Recipient email address"),
    subject: z.string().optional().describe("Email subject"),
    body: z.string().describe("Email body text"),
    thread_id: z.string().optional().describe("Gmail thread ID if this is a reply"),
    contact_row_ref: z.string().optional().describe("Optional Sheets contact row reference for CRM linking"),
  }, async ({ to_email, subject, body, thread_id, contact_row_ref }, extra) => {
    try {
      const db = getDb()
      const id = randomUUID()
      db.prepare(
        "INSERT INTO drafts (id, to_email, gmail_thread_id, subject, body, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      ).run(id, to_email, thread_id ?? null, subject ?? null, body)
      let draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRecord
      const context = resolveHolabossTurnContext(extra.requestInfo?.headers)
      try {
        const outputId = await syncDraftOutput(
          draft,
          { contactRowRef: contact_row_ref ?? null },
          context,
        )
        if (outputId && outputId !== draft.output_id) {
          persistDraftOutputId(db, draft.id, outputId)
          draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRecord
        }
      } catch (outputError) {
        db.prepare("DELETE FROM drafts WHERE id = ?").run(id)
        throw outputError
      }
      return text(draft)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_send_draft", "Send a pending draft via Gmail API. The email is queued and sent with automatic retries.", {
    draft_id: z.string().describe("Local draft ID"),
  }, async ({ draft_id }) => {
    try {
      const db = getDb()
      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draft_id) as DraftRecord | undefined
      if (!draft) return err("Draft not found")
      if (draft.status !== "pending" && draft.status !== "failed") return err(`Draft cannot be sent (status: ${draft.status})`)

      const holabossUserId = process.env.HOLABOSS_USER_ID ?? ""
      const jobId = enqueueSend({
        draft_id: draft.id,
        to_email: draft.to_email,
        subject: draft.subject ?? "",
        body: draft.body,
        thread_id: draft.gmail_thread_id ?? undefined,
        holaboss_user_id: holabossUserId,
      })

      db.prepare(
        "UPDATE drafts SET status = 'queued', error_message = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run(draft_id)

      return text({
        draft_id,
        job_id: jobId,
        output_id: draft.output_id,
        status: "queued",
      })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_update_draft", "Update the content of a pending email draft.", {
    draft_id: z.string().describe("Local draft ID"),
    to_email: z.string().optional().describe("New recipient email"),
    subject: z.string().optional().describe("New subject"),
    body: z.string().optional().describe("New body text"),
    thread_id: z.string().optional().describe("Gmail thread ID to link as reply"),
  }, async ({ draft_id, to_email, subject, body, thread_id }) => {
    try {
      const db = getDb()
      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draft_id) as DraftRecord | undefined
      if (!draft) return err("Draft not found")
      if (draft.status !== "pending" && draft.status !== "failed") return err(`Draft cannot be edited (status: ${draft.status})`)

      db.prepare(`
        UPDATE drafts SET
          to_email = COALESCE(?, to_email),
          subject = COALESCE(?, subject),
          body = COALESCE(?, body),
          gmail_thread_id = COALESCE(?, gmail_thread_id),
          status = 'pending',
          error_message = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(to_email ?? null, subject ?? null, body ?? null, thread_id ?? null, draft_id)

      const updated = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draft_id) as DraftRecord
      try {
        await syncDraftOutput(updated)
      } catch (outputError) {
        console.warn("[gmail] failed to sync draft output after update", outputError)
      }
      return text(updated)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_get_send_status", "Check the send status of a draft", {
    draft_id: z.string().describe("Local draft ID"),
  }, async ({ draft_id }) => {
    try {
      const db = getDb()
      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draft_id) as DraftRecord | undefined
      if (!draft) return err("Draft not found")
      return text({
        draft_id,
        status: draft.status,
        error_message: draft.error_message,
        sent_at: draft.sent_at,
        updated_at: draft.updated_at,
      })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_delete_draft", "Delete an email draft. Only pending or failed drafts can be deleted.", {
    draft_id: z.string().describe("Local draft ID"),
  }, async ({ draft_id }) => {
    try {
      const db = getDb()
      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draft_id) as DraftRecord | undefined
      if (!draft) return err("Draft not found")
      if (draft.status === "queued") return err("Cannot delete a draft that is currently being sent")
      if (draft.status === "sent") return err("Cannot delete a sent email")
      db.prepare("DELETE FROM drafts WHERE id = ?").run(draft_id)
      return text({ deleted: true, draft_id })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_list_drafts", "List email drafts", {
    status: z.string().optional().describe("Filter by status (pending, queued, sent, failed, discarded). Omit to list all."),
    limit: z.number().optional().describe("Max results, default 20"),
  }, async ({ status, limit }) => {
    try {
      const db = getDb()
      const max = limit ?? 20
      let rows: DraftRecord[]
      if (status) {
        rows = db.prepare("SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, max) as DraftRecord[]
      } else {
        rows = db.prepare("SELECT * FROM drafts ORDER BY created_at DESC LIMIT ?").all(max) as DraftRecord[]
      }
      return text(rows)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  return server
}

export { createMcpServer }

export function startMcpServer(port: number) {
  const transports = new Map<string, SSEServerTransport>()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)

    if (url.pathname === "/mcp/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }

    if (url.pathname === "/mcp/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/mcp/messages", res)
      transports.set(transport.sessionId, transport)
      const server = createMcpServer()
      await server.connect(transport)
      return
    }

    if (url.pathname === "/mcp/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId")
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(400)
        res.end("Unknown session")
        return
      }
      await transport.handlePostMessage(req, res)
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  httpServer.listen(port, () => {
    console.log(`[mcp] SSE server listening on port ${port}`)
  })

  return httpServer
}
