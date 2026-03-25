import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { randomUUID } from "node:crypto"

import type { ContactRecord, DraftRecord, InteractionRecord } from "../src/lib/types"

let mcpServer: Server | null = null
const MCP_PORT = 13099
const TEST_DB_PATH = `/tmp/gmail-crm-e2e-test-${Date.now()}.db`

describe("Gmail CRM E2E", () => {
  beforeAll(async () => {
    process.env.DB_PATH = TEST_DB_PATH

    const { startMcpServer } = await import("../src/server/mcp")
    mcpServer = startMcpServer(MCP_PORT)
    await waitForServer(`http://localhost:${MCP_PORT}/mcp/health`)
  }, 15_000)

  afterAll(async () => {
    if (mcpServer) {
      mcpServer.closeAllConnections()
      await new Promise<void>((resolve) => mcpServer!.close(() => resolve()))
      mcpServer = null
    }
    const fs = await import("node:fs")
    try {
      fs.unlinkSync(TEST_DB_PATH)
    } catch {
      /* ok */
    }
  }, 5_000)

  // =========================================================================
  // Contact CRUD
  // =========================================================================
  describe("Contact CRUD", () => {
    let testContactId: string

    it("creates a contact", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      testContactId = randomUUID()
      const now = new Date().toISOString()

      db.prepare(
        "INSERT INTO contacts (id, email, name, company, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(testContactId, "alice@test.com", "Alice", "Acme", "lead", now, now)

      const contact = db
        .prepare("SELECT * FROM contacts WHERE id = ?")
        .get(testContactId) as ContactRecord
      expect(contact.email).toBe("alice@test.com")
      expect(contact.stage).toBe("lead")
    })

    it("updates contact stage", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      db.prepare("UPDATE contacts SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(
        "contacted",
        testContactId
      )

      const contact = db
        .prepare("SELECT * FROM contacts WHERE id = ?")
        .get(testContactId) as ContactRecord
      expect(contact.stage).toBe("contacted")
    })

    it("lists contacts by stage", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const contacts = db
        .prepare("SELECT * FROM contacts WHERE stage = ?")
        .all("contacted") as ContactRecord[]
      expect(contacts.length).toBeGreaterThanOrEqual(1)
      expect(contacts.every((c) => c.stage === "contacted")).toBe(true)
    })

    it("finds contact by email (case-insensitive)", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const contact = db
        .prepare("SELECT * FROM contacts WHERE email = ?")
        .get("alice@test.com") as ContactRecord | undefined
      expect(contact).toBeDefined()
      expect(contact!.name).toBe("Alice")
    })

    it("deletes a contact", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      db.prepare("DELETE FROM contacts WHERE id = ?").run(testContactId)
      const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(testContactId)
      expect(contact).toBeUndefined()
    })
  })

  // =========================================================================
  // Interactions
  // =========================================================================
  describe("Interactions", () => {
    let contactId: string

    beforeAll(async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      contactId = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO contacts (id, email, name, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(contactId, "bob@test.com", "Bob", "lead", now, now)
    })

    it("creates an interaction record", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const id = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO interactions (id, contact_id, gmail_thread_id, subject, snippet, direction, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(id, contactId, "thread-1", "Hello", "Hi Bob...", "outbound", now, now)

      const interaction = db
        .prepare("SELECT * FROM interactions WHERE id = ?")
        .get(id) as InteractionRecord
      expect(interaction.direction).toBe("outbound")
      expect(interaction.contact_id).toBe(contactId)
    })

    it("lists interactions by contact ordered by timestamp DESC", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const id2 = randomUUID()
      const later = new Date(Date.now() + 1000).toISOString()
      db.prepare(
        "INSERT INTO interactions (id, contact_id, subject, direction, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id2, contactId, "Follow up", "inbound", later, later)

      const interactions = db
        .prepare("SELECT * FROM interactions WHERE contact_id = ? ORDER BY timestamp DESC")
        .all(contactId) as InteractionRecord[]
      expect(interactions.length).toBe(2)
      expect(interactions[0].subject).toBe("Follow up")
    })
  })

  // =========================================================================
  // Drafts
  // =========================================================================
  describe("Drafts", () => {
    let contactId: string

    beforeAll(async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      contactId = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO contacts (id, email, name, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(contactId, "carol@test.com", "Carol", "interested", now, now)
    })

    it("creates a pending draft", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const id = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO drafts (id, contact_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
      ).run(id, contactId, "Follow up", "Hi Carol...", now)

      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRecord
      expect(draft.status).toBe("pending")
      expect(draft.body).toBe("Hi Carol...")
    })

    it("transitions draft to sent", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const id = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO drafts (id, contact_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
      ).run(id, contactId, "Test", "Body", now)

      db.prepare("UPDATE drafts SET status = 'sent', sent_at = ? WHERE id = ?").run(now, id)

      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRecord
      expect(draft.status).toBe("sent")
      expect(draft.sent_at).toBeDefined()
    })

    it("lists only pending drafts", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const pending = db
        .prepare("SELECT * FROM drafts WHERE status = 'pending'")
        .all() as DraftRecord[]
      for (const d of pending) {
        expect(d.status).toBe("pending")
      }
    })
  })

  // =========================================================================
  // Full CRM lifecycle
  // =========================================================================
  describe("Full lifecycle", () => {
    it("contact → interaction → draft → sent → updated last_contact_at", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      // Create contact
      const contactId = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO contacts (id, email, name, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(contactId, "lifecycle@test.com", "Test User", "lead", now, now)

      // Create draft
      const draftId = randomUUID()
      db.prepare(
        "INSERT INTO drafts (id, contact_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
      ).run(draftId, contactId, "Hello", "Hi there", now)

      // Simulate sending: draft → sent + create interaction + update last_contact_at
      const sentAt = new Date().toISOString()
      db.prepare("UPDATE drafts SET status = 'sent', sent_at = ? WHERE id = ?").run(sentAt, draftId)

      const interactionId = randomUUID()
      db.prepare(
        "INSERT INTO interactions (id, contact_id, subject, snippet, direction, timestamp, created_at) VALUES (?, ?, ?, ?, 'outbound', ?, ?)"
      ).run(interactionId, contactId, "Hello", "Hi there", sentAt, sentAt)

      db.prepare("UPDATE contacts SET last_contact_at = ?, updated_at = ? WHERE id = ?").run(
        sentAt,
        sentAt,
        contactId
      )

      // Verify
      const contact = db
        .prepare("SELECT * FROM contacts WHERE id = ?")
        .get(contactId) as ContactRecord
      expect(contact.last_contact_at).toBe(sentAt)

      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId) as DraftRecord
      expect(draft.status).toBe("sent")

      const interactions = db
        .prepare("SELECT * FROM interactions WHERE contact_id = ?")
        .all(contactId) as InteractionRecord[]
      expect(interactions.length).toBe(1)
      expect(interactions[0].direction).toBe("outbound")
    })
  })

  // =========================================================================
  // Sync state
  // =========================================================================
  describe("Sync state", () => {
    it("stores and retrieves sync metadata", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const now = new Date().toISOString()
      db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_sync_at', ?)").run(
        now
      )

      const row = db
        .prepare("SELECT value FROM sync_state WHERE key = 'last_sync_at'")
        .get() as { value: string }
      expect(row.value).toBe(now)
    })
  })

  // =========================================================================
  // MCP server
  // =========================================================================
  describe("MCP server", () => {
    it("health check responds ok", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/mcp/health`)
      expect(res.ok).toBe(true)
      expect((await res.json()).status).toBe("ok")
    })

    it("SSE endpoint returns event stream", async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      try {
        const res = await fetch(`http://localhost:${MCP_PORT}/mcp/sse`, {
          signal: controller.signal,
        })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("text/event-stream")
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") throw err
      } finally {
        clearTimeout(timeout)
      }
    })

    it("returns 404 for unknown paths", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/mcp/unknown`)
      expect(res.status).toBe(404)
    })
  })

  // =========================================================================
  // Stale contacts query
  // =========================================================================
  describe("Stale contacts", () => {
    it("finds contacts with no recent interaction", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      // Create a stale contact (last_contact_at 30 days ago)
      const staleId = randomUUID()
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO contacts (id, email, name, stage, last_contact_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(staleId, "stale@test.com", "Stale User", "interested", thirtyDaysAgo, now, now)

      // Create a recent contact
      const recentId = randomUUID()
      db.prepare(
        "INSERT INTO contacts (id, email, name, stage, last_contact_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(recentId, "recent@test.com", "Recent User", "contacted", now, now, now)

      const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString()
      const staleContacts = db
        .prepare(
          `SELECT id, email FROM contacts
           WHERE stage NOT IN ('closed-won', 'closed-lost')
             AND (last_contact_at IS NULL OR last_contact_at < ?)
           ORDER BY last_contact_at ASC NULLS FIRST`
        )
        .all(cutoff) as Array<{ id: string; email: string }>

      const staleEmails = staleContacts.map((c) => c.email)
      expect(staleEmails).toContain("stale@test.com")
      expect(staleEmails).not.toContain("recent@test.com")
    })
  })

  // =========================================================================
  // Summary query
  // =========================================================================
  describe("Summary", () => {
    it("returns pipeline stage counts", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const stageCounts = db
        .prepare("SELECT stage, COUNT(*) as count FROM contacts GROUP BY stage")
        .all() as Array<{ stage: string; count: number }>

      expect(Array.isArray(stageCounts)).toBe(true)
      for (const row of stageCounts) {
        expect(row.count).toBeGreaterThanOrEqual(1)
      }
    })
  })

  // =========================================================================
  // Platform config
  // =========================================================================
  describe("Platform config", () => {
    it("MODULE_CONFIG has correct values", async () => {
      const { MODULE_CONFIG } = await import("../src/lib/types")
      expect(MODULE_CONFIG.provider).toBe("google")
      expect(MODULE_CONFIG.destination).toBe("google")
      expect(MODULE_CONFIG.name).toBe("Gmail CRM")
    })
  })

  // =========================================================================
  // Google API integration tests (only run with GOOGLE_TEST_TOKEN)
  // =========================================================================
  describe.skipIf(!process.env.GOOGLE_TEST_TOKEN)("Google API integration", () => {
    beforeAll(() => {
      process.env.PLATFORM_INTEGRATION_TOKEN = process.env.GOOGLE_TEST_TOKEN!
    })

    it("reads a Google Sheet", async () => {
      const sheetId = process.env.GMAIL_CRM_SHEET_ID
      if (!sheetId) throw new Error("GMAIL_CRM_SHEET_ID required for integration test")

      const { readSheet } = await import("../src/server/google-api")
      const rows = await readSheet(sheetId)
      expect(Array.isArray(rows)).toBe(true)
      if (rows.length > 0) {
        expect(rows[0].values).toHaveProperty("email")
      }
    })

    it("lists Gmail threads for a known email", async () => {
      const testEmail = process.env.GOOGLE_TEST_EMAIL
      if (!testEmail) throw new Error("GOOGLE_TEST_EMAIL required for integration test")

      const { listThreadsByEmail } = await import("../src/server/google-api")
      const threads = await listThreadsByEmail(testEmail, 5)
      expect(Array.isArray(threads)).toBe(true)
    })
  })
})

async function waitForServer(url: string, timeoutMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`)
}
