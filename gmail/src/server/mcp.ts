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

// Tool descriptions follow ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md
type ErrorCode =
  | "not_found"
  | "invalid_state"
  | "validation_failed"
  | "not_connected"
  | "rate_limited"
  | "upstream_error"
  | "internal"

function text(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] } }
function success<T extends Record<string, unknown>>(data: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data }
}
function errCode(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ code, message, ...extra }) }], isError: true as const }
}
function upstreamErr(e: unknown) {
  return errCode("upstream_error", e instanceof Error ? e.message : String(e))
}

// Output shapes
const DraftStatusEnum = z.enum(["pending", "queued", "sent", "failed", "discarded"])
const DraftRecordShape = {
  id: z.string(),
  to_email: z.string(),
  gmail_thread_id: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  status: DraftStatusEnum,
  output_id: z.string().nullable(),
  error_message: z.string().nullable(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}
const SendResultShape = {
  draft_id: z.string(),
  job_id: z.union([z.string(), z.number()]),
  output_id: z.string().nullable(),
  status: z.literal("queued"),
}
const SendStatusShape = {
  draft_id: z.string(),
  status: DraftStatusEnum,
  error_message: z.string().nullable(),
  sent_at: z.string().nullable(),
  updated_at: z.string(),
}
const ParsedMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  snippet: z.string(),
  body: z.string(),
  sentAt: z.string(),
}).passthrough()
const ThreadShape = {
  id: z.string(),
  messages: z.array(ParsedMessageSchema),
}
const OpenThreadShape = {
  id: z.string(),
  subject: z.string(),
  primary_email: z.string().nullable(),
  output_id: z.string().nullable(),
  messages: z.array(ParsedMessageSchema),
}
const DeleteResultShape = { deleted: z.literal(true), draft_id: z.string() }

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
  db.prepare("UPDATE gmail_drafts SET output_id = ? WHERE id = ?").run(outputId, draftId)
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: `${MODULE_CONFIG.name} Module`,
    version: "1.0.0",
  })

  server.registerTool(
    "gmail_search",
    {
      title: "Search Gmail threads",
      description: `Search the user's Gmail using Gmail's standard query operators.

When to use: find threads matching a question like "messages from alice last week" → query='from:alice newer_than:7d'.
When NOT to use: to read a thread's full body — search returns only snippets; call gmail_get_thread next.
Operators: from:, to:, subject:, after:YYYY/MM/DD, before:, has:attachment, label:, is:unread, plus free text. Combine with spaces (AND) or 'OR'.
Returns: array of thread snippets — { id, snippet, lastMessageDate, ... }.`,
      inputSchema: {
        query: z
          .string()
          .describe(
            "Gmail search query, e.g. 'from:alice subject:meeting newer_than:7d'. See https://support.google.com/mail/answer/7190.",
          ),
        max_results: z.number().int().positive().max(100).optional().describe("Max results, default 10, max 100."),
      },
      annotations: {
        title: "Search Gmail threads",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, max_results }) => {
      try {
        const threads = await listThreads(query, max_results ?? 10)
        return text(threads)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "gmail_get_thread",
    {
      title: "Get Gmail thread",
      description: `Read a full Gmail thread including every message body.

Prerequisites: thread_id from gmail_search or gmail_open_thread.
When to use: the user wants to read or summarize an entire thread; you need full message bodies to compose a reply.
Returns: { id, messages: [{ id, from, to, subject, snippet, body, sentAt, ... }] } in chronological order.
Errors: { code: 'upstream_error' } on Gmail API failures.`,
      inputSchema: {
        thread_id: z.string().describe("Gmail thread id from gmail_search results."),
      },
      outputSchema: ThreadShape,
      annotations: {
        title: "Get Gmail thread",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ thread_id }) => {
      try {
        const thread = await getThread(thread_id)
        const messages = thread.messages.map(parseMessage)
        return success({ id: thread.id, messages } as Record<string, unknown>)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "gmail_open_thread",
    {
      title: "Open thread as workspace output",
      description: `Pin a Gmail thread as a durable workspace output so the CRM and other tools can reference it. Idempotent — opening the same thread twice updates the existing output.

When to use: before adding a thread to a CRM follow-up workflow, or when the user asks to 'save', 'pin', or 'track' an email thread.
Prerequisites: thread_id from gmail_search.
Side effects: publishes (or updates) an app output that other modules can link to. Pass contact_row_ref to wire it to a Sheets CRM contact.
Returns: { id, subject, primary_email, output_id, messages }.
Errors: { code: 'upstream_error' } on Gmail API failures.`,
      inputSchema: {
        thread_id: z.string().describe("Gmail thread id from gmail_search."),
        contact_email: z
          .string()
          .optional()
          .describe("Override the primary CRM contact email; otherwise inferred from the thread participants."),
        contact_row_ref: z
          .string()
          .optional()
          .describe(
            "Sheets contact row reference for CRM linking — typically the value returned by sheets tools when working with a contacts sheet.",
          ),
      },
      outputSchema: OpenThreadShape,
      annotations: {
        title: "Open thread as workspace output",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ thread_id, contact_email, contact_row_ref }) => {
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

        return success({
          id: thread.id,
          subject,
          primary_email: primaryEmail || null,
          output_id: outputId,
          messages,
        } as Record<string, unknown>)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "gmail_draft_reply",
    {
      title: "Create email draft",
      description: `Create an email draft locally. Stored in the module's SQLite — NOT sent. Call gmail_send_draft to actually send.

When to use: the user dictates a reply or new email to compose, OR you want to stage an outgoing email for review.
When NOT to use: to update an existing draft (use gmail_update_draft). To send immediately (call gmail_send_draft after this).
Prerequisites: for replies, thread_id from gmail_search or gmail_get_thread (so Gmail threads correctly).
Returns: full DraftRecord — { id, to_email, subject, body, gmail_thread_id?, status: 'pending', output_id?, ... }.
Errors: { code: 'upstream_error' } if the workspace output sync fails.`,
      inputSchema: {
        to_email: z.string().describe("Recipient email address, e.g. 'alice@example.com'."),
        subject: z.string().optional().describe("Email subject. Optional for replies (Gmail uses the thread subject)."),
        body: z.string().describe("Email body (plain text)."),
        thread_id: z
          .string()
          .optional()
          .describe("Gmail thread id if this is a reply. Omit for a new email."),
        contact_row_ref: z
          .string()
          .optional()
          .describe(
            "Sheets contact row reference for CRM linking — value typically returned by sheets tools when working with a contacts sheet.",
          ),
      },
      outputSchema: DraftRecordShape,
      annotations: {
        title: "Create email draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ to_email, subject, body, thread_id, contact_row_ref }, extra) => {
      try {
        const db = getDb()
        const id = randomUUID()
        db.prepare(
          "INSERT INTO gmail_drafts (id, to_email, gmail_thread_id, subject, body, status) VALUES (?, ?, ?, ?, ?, 'pending')",
        ).run(id, to_email, thread_id ?? null, subject ?? null, body)
        let draft = db.prepare("SELECT * FROM gmail_drafts WHERE id = ?").get(id) as DraftRecord
        const context = resolveHolabossTurnContext(extra.requestInfo?.headers)
        try {
          const outputId = await syncDraftOutput(
            draft,
            { contactRowRef: contact_row_ref ?? null },
            context,
          )
          if (outputId && outputId !== draft.output_id) {
            persistDraftOutputId(db, draft.id, outputId)
            draft = db.prepare("SELECT * FROM gmail_drafts WHERE id = ?").get(id) as DraftRecord
          }
        } catch (outputError) {
          db.prepare("DELETE FROM gmail_drafts WHERE id = ?").run(id)
          throw outputError
        }
        return success(draft as unknown as Record<string, unknown>)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "gmail_send_draft",
    {
      title: "Send draft",
      description: `Enqueue a draft for sending via the Gmail API. Sends asynchronously with retries; poll gmail_get_send_status for outcome.

When to use: the user has approved a draft and wants it sent.
Prerequisites: a draft created by gmail_draft_reply.
Valid states: 'pending' or 'failed' (retries a failed draft). Calling on 'queued' / 'sent' / 'discarded' returns isError.
Side effects: status flips to 'queued'. The actual Gmail API call happens asynchronously.
Returns: { draft_id, job_id, output_id?, status: 'queued' }.
Errors: { code: 'not_found' } if draft_id is unknown; { code: 'invalid_state', current_status, allowed_from } if status isn't 'pending' or 'failed'.`,
      inputSchema: {
        draft_id: z.string().describe("Local draft id returned by gmail_draft_reply."),
      },
      outputSchema: SendResultShape,
      annotations: {
        title: "Send draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ draft_id }) => {
      try {
        const db = getDb()
        const draft = db.prepare("SELECT * FROM gmail_drafts WHERE id = ?").get(draft_id) as DraftRecord | undefined
        if (!draft) return errCode("not_found", "Draft not found")
        if (draft.status !== "pending" && draft.status !== "failed") return errCode("invalid_state", `Draft cannot be sent (status: ${draft.status})`, { current_status: draft.status, allowed_from: ["pending", "failed"] })

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
          "UPDATE gmail_drafts SET status = 'queued', error_message = NULL, updated_at = datetime('now') WHERE id = ?",
        ).run(draft_id)

        return success({
          draft_id,
          job_id: jobId,
          output_id: draft.output_id,
          status: "queued" as const,
        })
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "gmail_update_draft",
    {
      title: "Update draft",
      description: `Edit an unsent draft. Only fields you supply change. If the draft was 'failed', status resets to 'pending' so you can retry by calling gmail_send_draft.

When to use: revise a draft before sending, or fix a failed send and retry.
Valid states: 'pending' or 'failed'. Calling on 'queued' / 'sent' / 'discarded' returns isError.
Returns: full updated DraftRecord.
Errors: { code: 'not_found' } if draft_id is unknown; { code: 'invalid_state', current_status, allowed_from } if status isn't 'pending' or 'failed'.`,
      inputSchema: {
        draft_id: z.string().describe("Local draft id returned by gmail_draft_reply or gmail_list_drafts."),
        to_email: z.string().optional().describe("New recipient email."),
        subject: z.string().optional().describe("New subject."),
        body: z.string().optional().describe("New body text."),
        thread_id: z.string().optional().describe("Gmail thread id to link this draft as a reply."),
      },
      outputSchema: DraftRecordShape,
      annotations: {
        title: "Update draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ draft_id, to_email, subject, body, thread_id }) => {
      try {
        const db = getDb()
        const draft = db.prepare("SELECT * FROM gmail_drafts WHERE id = ?").get(draft_id) as DraftRecord | undefined
        if (!draft) return errCode("not_found", "Draft not found")
        if (draft.status !== "pending" && draft.status !== "failed") return errCode("invalid_state", `Draft cannot be edited (status: ${draft.status})`, { current_status: draft.status, allowed_from: ["pending", "failed"] })

        db.prepare(`
          UPDATE gmail_drafts SET
            to_email = COALESCE(?, to_email),
            subject = COALESCE(?, subject),
            body = COALESCE(?, body),
            gmail_thread_id = COALESCE(?, gmail_thread_id),
            status = 'pending',
            error_message = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(to_email ?? null, subject ?? null, body ?? null, thread_id ?? null, draft_id)

        const updated = db.prepare("SELECT * FROM gmail_drafts WHERE id = ?").get(draft_id) as DraftRecord
        try {
          await syncDraftOutput(updated)
        } catch (outputError) {
          console.warn("[gmail] failed to sync draft output after update", outputError)
        }
        return success(updated as unknown as Record<string, unknown>)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "gmail_get_send_status",
    {
      title: "Get send status",
      description: `Read the current send status of a draft without mutating it.

When to use: after gmail_send_draft, poll until status is 'sent' (success) or 'failed' (error_message will explain).
Returns: { draft_id, status, error_message?, sent_at?, updated_at }.
States: 'pending' | 'queued' | 'sent' | 'failed' | 'discarded'.
Errors: { code: 'not_found' } if draft_id is unknown.`,
      inputSchema: {
        draft_id: z.string().describe("Local draft id returned by gmail_draft_reply or gmail_send_draft."),
      },
      outputSchema: SendStatusShape,
      annotations: {
        title: "Get send status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ draft_id }) => {
      try {
        const db = getDb()
        const draft = db.prepare("SELECT * FROM gmail_drafts WHERE id = ?").get(draft_id) as DraftRecord | undefined
        if (!draft) return errCode("not_found", "Draft not found")
        return success({
          draft_id,
          status: draft.status,
          error_message: draft.error_message,
          sent_at: draft.sent_at,
          updated_at: draft.updated_at,
        })
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "gmail_delete_draft",
    {
      title: "Delete draft",
      description: `Permanently delete an unsent draft. Cannot be undone. Does NOT recall an already-sent email.

When to use: throw away a draft the user no longer wants.
Valid states: 'pending' or 'failed'. 'queued' (currently being sent) and 'sent' (already delivered) cannot be deleted.
Returns: { deleted: true, draft_id }.
Errors: { code: 'not_found' } if draft_id is unknown; { code: 'invalid_state', current_status } if status is 'queued' or 'sent'.`,
      inputSchema: {
        draft_id: z.string().describe("Local draft id (must be 'pending' or 'failed')."),
      },
      outputSchema: DeleteResultShape,
      annotations: {
        title: "Delete draft",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ draft_id }) => {
      try {
        const db = getDb()
        const draft = db.prepare("SELECT * FROM gmail_drafts WHERE id = ?").get(draft_id) as DraftRecord | undefined
        if (!draft) return errCode("not_found", "Draft not found")
        if (draft.status === "queued") return errCode("invalid_state", "Cannot delete a draft that is currently being sent", { current_status: "queued" })
        if (draft.status === "sent") return errCode("invalid_state", "Cannot delete a sent email", { current_status: "sent" })
        db.prepare("DELETE FROM gmail_drafts WHERE id = ?").run(draft_id)
        return success({ deleted: true as const, draft_id })
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "gmail_list_drafts",
    {
      title: "List local drafts",
      description: `List local Holaboss-managed email drafts ordered by created_at DESC. Does NOT list drafts visible in the Gmail web UI — only drafts created via gmail_draft_reply.

When to use: find a specific local draft, audit recent send attempts, filter by lifecycle state.
Returns: array of DraftRecord. Empty array if none match.`,
      inputSchema: {
        status: z
          .enum(["pending", "queued", "sent", "failed", "discarded"])
          .optional()
          .describe("Filter by lifecycle state. Omit to list all states."),
        limit: z.number().int().positive().max(200).optional().describe("Max results, default 20, max 200."),
      },
      annotations: {
        title: "List local drafts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status, limit }) => {
      try {
        const db = getDb()
        const max = limit ?? 20
        let rows: DraftRecord[]
        if (status) {
          rows = db.prepare("SELECT * FROM gmail_drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, max) as DraftRecord[]
        } else {
          rows = db.prepare("SELECT * FROM gmail_drafts ORDER BY created_at DESC LIMIT ?").all(max) as DraftRecord[]
        }
        return text(rows)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

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
