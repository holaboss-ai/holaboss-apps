import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import type { DraftRecord } from "../lib/types"
import { MODULE_CONFIG } from "../lib/types"
import { getDb } from "./db"
import { listThreads, getThread, parseMessage, sendEmail } from "./google-api"

function text(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] } }
function err(message: string) { return { content: [{ type: "text" as const, text: message }], isError: true } }

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

  server.tool("gmail_draft_reply", "Create an email draft (stored locally, NOT sent). Use gmail_send_draft to send.", {
    to_email: z.string().describe("Recipient email address"),
    subject: z.string().optional().describe("Email subject"),
    body: z.string().describe("Email body text"),
    thread_id: z.string().optional().describe("Gmail thread ID if this is a reply"),
  }, async ({ to_email, subject, body, thread_id }) => {
    try {
      const db = getDb()
      const id = randomUUID()
      db.prepare(
        "INSERT INTO drafts (id, to_email, gmail_thread_id, subject, body, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      ).run(id, to_email, thread_id ?? null, subject ?? null, body)
      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRecord
      return text(draft)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_send_draft", "Send a pending draft via Gmail API", {
    draft_id: z.string().describe("Local draft ID"),
  }, async ({ draft_id }) => {
    try {
      const db = getDb()
      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draft_id) as DraftRecord | undefined
      if (!draft) return err("Draft not found")
      if (draft.status !== "pending") return err(`Draft is not pending (status: ${draft.status})`)

      const result = await sendEmail({
        to: draft.to_email,
        subject: draft.subject ?? "",
        body: draft.body,
        threadId: draft.gmail_thread_id ?? undefined,
      })

      db.prepare(
        "UPDATE drafts SET status = 'sent', sent_at = datetime('now') WHERE id = ?",
      ).run(draft_id)

      return text({ draft_id, message_id: result.id, thread_id: result.threadId, status: "sent" })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("gmail_list_drafts", "List pending email drafts", {
    status: z.string().optional().describe("Filter by status (pending, sent, discarded). Default: pending"),
    limit: z.number().optional().describe("Max results, default 20"),
  }, async ({ status, limit }) => {
    try {
      const db = getDb()
      const max = limit ?? 20
      const filterStatus = status ?? "pending"
      const rows = db.prepare("SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(filterStatus, max) as DraftRecord[]
      return text(rows)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  return server
}

let _instance: McpServer | null = null

export function getMcpServer(): McpServer {
  if (!_instance) {
    _instance = createMcpServer()
  }
  return _instance
}
