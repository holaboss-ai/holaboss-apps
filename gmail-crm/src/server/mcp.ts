import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { z } from "zod"

import type { ContactRecord, DraftRecord, InteractionRecord } from "../lib/types"
import { MODULE_CONFIG, STAGES } from "../lib/types"
import { getDb } from "./db"
import {
  appendSheetRow,
  getThread,
  listThreadsByEmail,
  parseMessage,
  readSheet,
  sendEmail,
  updateSheetCell,
} from "./google-api"

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true }
}

function getSheetId(): string {
  const id = process.env.GMAIL_CRM_SHEET_ID ?? ""
  if (!id) throw new Error("GMAIL_CRM_SHEET_ID is not set")
  return id
}

// Column letter helper for Sheet write-back (A=1, B=2, ...)
function colLetter(index: number): string {
  let result = ""
  let n = index
  while (n > 0) {
    n--
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: `${MODULE_CONFIG.name} Module`,
    version: "1.0.0",
  })

  // -----------------------------------------------------------------------
  // 1. gmail_crm_sync_contacts
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_sync_contacts",
    "Sync contacts from the configured Google Sheet into the CRM. Creates new contacts, updates changed ones.",
    {},
    async () => {
      const sheetId = getSheetId()
      const rows = await readSheet(sheetId)
      const db = getDb()
      const now = new Date().toISOString()
      let created = 0
      let updated = 0

      for (const row of rows) {
        const email = row.values.email?.toLowerCase()
        if (!email) continue

        const existing = db
          .prepare("SELECT id, name, company, stage, notes FROM contacts WHERE email = ?")
          .get(email) as ContactRecord | undefined

        if (existing) {
          const name = row.values.name || existing.name
          const company = row.values.company || existing.company
          const stage = row.values.stage || existing.stage
          const notes = row.values.notes || existing.notes
          if (
            name !== existing.name ||
            company !== existing.company ||
            stage !== existing.stage ||
            notes !== existing.notes
          ) {
            db.prepare(
              "UPDATE contacts SET name = ?, company = ?, stage = ?, notes = ?, sheet_row_number = ?, updated_at = ? WHERE id = ?"
            ).run(name, company, stage, notes, row.rowNumber, now, existing.id)
            updated++
          }
        } else {
          const id = randomUUID()
          db.prepare(
            "INSERT INTO contacts (id, email, name, company, stage, notes, sheet_row_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(
            id,
            email,
            row.values.name || null,
            row.values.company || null,
            row.values.stage || "lead",
            row.values.notes || null,
            row.rowNumber,
            now,
            now
          )
          created++
        }
      }

      db.prepare(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_sync_at', ?)"
      ).run(now)

      return text({ created, updated, total: rows.length, synced_at: now })
    }
  )

  // -----------------------------------------------------------------------
  // 2. gmail_crm_list_contacts
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_list_contacts",
    "List CRM contacts. Filter by stage, tag, or search query.",
    {
      stage: z.string().optional().describe("Filter by pipeline stage"),
      search: z.string().optional().describe("Search name, email, or company"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ stage, search, limit }) => {
      const db = getDb()
      const max = limit ?? 20
      let query = "SELECT id, email, name, company, stage, last_contact_at FROM contacts WHERE 1=1"
      const params: unknown[] = []

      if (stage) {
        query += " AND stage = ?"
        params.push(stage)
      }
      if (search) {
        query += " AND (name LIKE ? OR email LIKE ? OR company LIKE ?)"
        const pattern = `%${search}%`
        params.push(pattern, pattern, pattern)
      }
      query += " ORDER BY last_contact_at DESC NULLS LAST, updated_at DESC LIMIT ?"
      params.push(max)

      const rows = db.prepare(query).all(...params)
      return text(rows)
    }
  )

  // -----------------------------------------------------------------------
  // 3. gmail_crm_get_contact
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_get_contact",
    "Get full contact detail with recent interactions.",
    {
      email: z.string().optional().describe("Contact email"),
      contact_id: z.string().optional().describe("Contact ID"),
    },
    async ({ email, contact_id }) => {
      const db = getDb()
      let contact: ContactRecord | undefined
      if (contact_id) {
        contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contact_id) as ContactRecord | undefined
      } else if (email) {
        contact = db.prepare("SELECT * FROM contacts WHERE email = ?").get(email.toLowerCase()) as ContactRecord | undefined
      }
      if (!contact) return err("Contact not found")

      const interactions = db
        .prepare("SELECT * FROM interactions WHERE contact_id = ? ORDER BY timestamp DESC LIMIT 5")
        .all(contact.id) as InteractionRecord[]

      const pendingDrafts = db
        .prepare("SELECT id, subject, created_at FROM drafts WHERE contact_id = ? AND status = 'pending'")
        .all(contact.id) as Array<Pick<DraftRecord, "id" | "subject" | "created_at">>

      return text({ contact, recent_interactions: interactions, pending_drafts: pendingDrafts })
    }
  )

  // -----------------------------------------------------------------------
  // 4. gmail_crm_update_contact
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_update_contact",
    "Update a contact's stage, notes, or tags. Stage changes are synced back to Google Sheet.",
    {
      email: z.string().describe("Contact email"),
      stage: z.string().optional().describe("New pipeline stage"),
      notes: z.string().optional().describe("Updated notes"),
      tags: z.array(z.string()).optional().describe("Tags array"),
    },
    async ({ email, stage, notes, tags }) => {
      const db = getDb()
      const contact = db
        .prepare("SELECT * FROM contacts WHERE email = ?")
        .get(email.toLowerCase()) as ContactRecord | undefined
      if (!contact) return err("Contact not found")

      const now = new Date().toISOString()
      const updates: string[] = []
      const params: unknown[] = []

      if (stage !== undefined) {
        updates.push("stage = ?")
        params.push(stage)
      }
      if (notes !== undefined) {
        updates.push("notes = ?")
        params.push(notes)
      }
      if (tags !== undefined) {
        updates.push("tags = ?")
        params.push(JSON.stringify(tags))
      }

      if (updates.length === 0) return err("No fields to update")

      updates.push("updated_at = ?")
      params.push(now)
      params.push(contact.id)

      db.prepare(`UPDATE contacts SET ${updates.join(", ")} WHERE id = ?`).run(...params)

      // Write stage back to Sheet
      if (stage && contact.sheet_row_number) {
        try {
          const sheetId = getSheetId()
          const sheetRows = await readSheet(sheetId)
          const headerRow = sheetRows[0]
          if (headerRow) {
            // Find the stage column index from the first data row's keys
            const firstRow = await readSheet(sheetId)
            const sampleRow = firstRow[0]
            if (sampleRow) {
              const keys = Object.keys(sampleRow.values)
              const stageIndex = keys.indexOf("stage")
              if (stageIndex >= 0) {
                const cell = `${colLetter(stageIndex + 1)}${contact.sheet_row_number}`
                await updateSheetCell(sheetId, cell, stage)
              }
            }
          }
        } catch {
          // Best-effort Sheet sync — don't fail the update
        }
      }

      return text({ updated: true, email, stage, notes, tags })
    }
  )

  // -----------------------------------------------------------------------
  // 5. gmail_crm_add_contact
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_add_contact",
    "Add a new contact to the CRM and append to Google Sheet.",
    {
      email: z.string().describe("Email address"),
      name: z.string().optional().describe("Contact name"),
      company: z.string().optional().describe("Company name"),
      stage: z.string().optional().describe("Pipeline stage (default: lead)"),
      notes: z.string().optional().describe("Notes"),
    },
    async ({ email, name, company, stage, notes }) => {
      const db = getDb()
      const existing = db
        .prepare("SELECT id FROM contacts WHERE email = ?")
        .get(email.toLowerCase())
      if (existing) return err("Contact already exists")

      const id = randomUUID()
      const now = new Date().toISOString()
      const contactStage = stage ?? "lead"

      db.prepare(
        "INSERT INTO contacts (id, email, name, company, stage, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(id, email.toLowerCase(), name ?? null, company ?? null, contactStage, notes ?? null, now, now)

      // Append to Sheet
      try {
        const sheetId = getSheetId()
        await appendSheetRow(sheetId, "Sheet1", [
          email.toLowerCase(),
          name ?? "",
          company ?? "",
          contactStage,
          notes ?? "",
        ])
      } catch {
        // Best-effort — contact is already in SQLite
      }

      return text({ id, email, name, company, stage: contactStage })
    }
  )

  // -----------------------------------------------------------------------
  // 6. gmail_crm_get_thread
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_get_thread",
    "Read a full Gmail thread. Returns all messages with sender, date, subject, and body.",
    {
      thread_id: z.string().describe("Gmail thread ID"),
    },
    async ({ thread_id }) => {
      const thread = await getThread(thread_id)
      const messages = thread.messages.map(parseMessage)
      return text({
        thread_id: thread.id,
        message_count: messages.length,
        messages: messages.map((m) => ({
          from: m.from,
          to: m.to,
          subject: m.subject,
          date: m.date,
          body: m.body.slice(0, 2000),
          message_id: m.messageId,
        })),
      })
    }
  )

  // -----------------------------------------------------------------------
  // 7. gmail_crm_draft_reply
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_draft_reply",
    "Create an email draft for a contact. If thread_id is provided, it's a reply; otherwise a new email. Draft is NOT sent — use gmail_crm_send_draft to send.",
    {
      email: z.string().describe("Recipient email"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      thread_id: z.string().optional().describe("Gmail thread ID to reply to"),
    },
    async ({ email, subject, body, thread_id }) => {
      const db = getDb()
      const contact = db
        .prepare("SELECT id FROM contacts WHERE email = ?")
        .get(email.toLowerCase()) as ContactRecord | undefined
      if (!contact) return err("Contact not found in CRM")

      const id = randomUUID()
      const now = new Date().toISOString()

      db.prepare(
        "INSERT INTO drafts (id, contact_id, gmail_thread_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
      ).run(id, contact.id, thread_id ?? null, subject, body, now)

      return text({ draft_id: id, to: email, subject, is_reply: !!thread_id, status: "pending" })
    }
  )

  // -----------------------------------------------------------------------
  // 8. gmail_crm_send_draft
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_send_draft",
    "Send a pending email draft. Creates an interaction record and updates last_contact_at.",
    {
      draft_id: z.string().describe("Draft ID to send"),
    },
    async ({ draft_id }) => {
      const db = getDb()
      const draft = db
        .prepare("SELECT * FROM drafts WHERE id = ? AND status = 'pending'")
        .get(draft_id) as DraftRecord | undefined
      if (!draft) return err("Draft not found or already sent")

      const contact = db
        .prepare("SELECT * FROM contacts WHERE id = ?")
        .get(draft.contact_id) as ContactRecord | undefined
      if (!contact) return err("Contact not found")

      // If replying to a thread, get the last message for In-Reply-To header
      let inReplyTo: string | undefined
      let references: string | undefined
      if (draft.gmail_thread_id) {
        try {
          const thread = await getThread(draft.gmail_thread_id)
          const lastMsg = thread.messages.at(-1)
          if (lastMsg) {
            const parsed = parseMessage(lastMsg)
            inReplyTo = parsed.messageId
            references = parsed.messageId
          }
        } catch {
          // Send without threading headers
        }
      }

      const result = await sendEmail({
        to: contact.email,
        subject: draft.subject ?? "",
        body: draft.body,
        threadId: draft.gmail_thread_id ?? undefined,
        inReplyTo,
        references,
      })

      const now = new Date().toISOString()

      // Mark draft as sent
      db.prepare("UPDATE drafts SET status = 'sent', sent_at = ? WHERE id = ?").run(now, draft_id)

      // Create interaction record
      const interactionId = randomUUID()
      db.prepare(
        "INSERT INTO interactions (id, contact_id, gmail_thread_id, gmail_message_id, subject, snippet, direction, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, 'outbound', ?, ?)"
      ).run(
        interactionId,
        contact.id,
        result.threadId,
        result.id,
        draft.subject,
        draft.body.slice(0, 200),
        now,
        now
      )

      // Update last_contact_at
      db.prepare("UPDATE contacts SET last_contact_at = ?, updated_at = ? WHERE id = ?").run(now, now, contact.id)

      return text({ sent: true, message_id: result.id, thread_id: result.threadId })
    }
  )

  // -----------------------------------------------------------------------
  // 9. gmail_crm_stale_contacts
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_stale_contacts",
    "Find contacts with no interaction in the specified number of days.",
    {
      days: z.number().optional().describe("Days since last contact (default 14)"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async ({ days, limit }) => {
      const db = getDb()
      const threshold = new Date()
      threshold.setDate(threshold.getDate() - (days ?? 14))
      const cutoff = threshold.toISOString()
      const max = limit ?? 10

      const contacts = db
        .prepare(
          `SELECT id, email, name, company, stage, last_contact_at
           FROM contacts
           WHERE stage NOT IN ('closed-won', 'closed-lost')
             AND (last_contact_at IS NULL OR last_contact_at < ?)
           ORDER BY last_contact_at ASC NULLS FIRST
           LIMIT ?`
        )
        .all(cutoff, max)

      return text(contacts)
    }
  )

  // -----------------------------------------------------------------------
  // 10. gmail_crm_summary
  // -----------------------------------------------------------------------
  server.tool(
    "gmail_crm_summary",
    "CRM overview: contact count per stage, recent interactions, pending drafts.",
    {},
    async () => {
      const db = getDb()

      const stageCounts = db
        .prepare("SELECT stage, COUNT(*) as count FROM contacts GROUP BY stage")
        .all() as Array<{ stage: string; count: number }>

      const totalContacts = db
        .prepare("SELECT COUNT(*) as count FROM contacts")
        .get() as { count: number }

      const recentInteractions = db
        .prepare("SELECT COUNT(*) as count FROM interactions WHERE timestamp > datetime('now', '-7 days')")
        .get() as { count: number }

      const pendingDrafts = db
        .prepare("SELECT COUNT(*) as count FROM drafts WHERE status = 'pending'")
        .get() as { count: number }

      const lastSync = db
        .prepare("SELECT value FROM sync_state WHERE key = 'last_sync_at'")
        .get() as { value: string } | undefined

      return text({
        total_contacts: totalContacts.count,
        by_stage: Object.fromEntries(stageCounts.map((r) => [r.stage, r.count])),
        interactions_this_week: recentInteractions.count,
        pending_drafts: pendingDrafts.count,
        last_sync: lastSync?.value ?? null,
      })
    }
  )

  return server
}

export function startMcpServer(port: number) {
  const mcpServer = createMcpServer()
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
      await mcpServer.connect(transport)
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
    console.log(`[mcp] Gmail CRM server listening on port ${port}`)
  })

  return httpServer
}
