import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { randomUUID } from "node:crypto"

import type { DraftRecord } from "../src/lib/types"

let mcpServer: Server | null = null
const MCP_PORT = 13099
const TEST_DB_PATH = `/tmp/gmail-e2e-test-${Date.now()}.db`

describe("Gmail Module E2E", () => {
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
    try { fs.unlinkSync(TEST_DB_PATH) } catch { /* ok */ }
  }, 5_000)

  // =========================================================================
  // Database schema
  // =========================================================================
  describe("Database schema", () => {
    it("creates drafts table on init", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
      const names = tables.map((t) => t.name)
      expect(names).toContain("drafts")
    })
  })

  // =========================================================================
  // Draft CRUD
  // =========================================================================
  describe("Draft CRUD", () => {
    let draftId: string

    it("creates a pending draft", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      draftId = randomUUID()
      const now = new Date().toISOString()

      db.prepare(
        "INSERT INTO drafts (id, to_email, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
      ).run(draftId, "alice@test.com", "Hello Alice", "Hi there!", now)

      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId) as DraftRecord
      expect(draft.status).toBe("pending")
      expect(draft.to_email).toBe("alice@test.com")
      expect(draft.body).toBe("Hi there!")
    })

    it("transitions draft to sent", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      const now = new Date().toISOString()

      db.prepare("UPDATE drafts SET status = 'sent', sent_at = ? WHERE id = ?").run(now, draftId)

      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId) as DraftRecord
      expect(draft.status).toBe("sent")
      expect(draft.sent_at).toBeDefined()
    })

    it("transitions draft to discarded", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      const id = randomUUID()
      const now = new Date().toISOString()

      db.prepare(
        "INSERT INTO drafts (id, to_email, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
      ).run(id, "bob@test.com", "Test", "Body", now)

      db.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ?").run(id)
      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRecord
      expect(draft.status).toBe("discarded")
    })

    it("lists only pending drafts", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      const id = randomUUID()
      const now = new Date().toISOString()

      db.prepare(
        "INSERT INTO drafts (id, to_email, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
      ).run(id, "carol@test.com", "Pending", "Still pending", now)

      const pending = db
        .prepare("SELECT * FROM drafts WHERE status = 'pending'")
        .all() as DraftRecord[]
      expect(pending.length).toBeGreaterThanOrEqual(1)
      for (const d of pending) {
        expect(d.status).toBe("pending")
      }
    })
  })

  // =========================================================================
  // Draft with thread (reply)
  // =========================================================================
  describe("Draft reply threading", () => {
    it("stores gmail_thread_id for replies", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      const id = randomUUID()
      const now = new Date().toISOString()

      db.prepare(
        "INSERT INTO drafts (id, to_email, gmail_thread_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
      ).run(id, "alice@test.com", "thread-abc-123", "Re: Hello", "Thanks!", now)

      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRecord
      expect(draft.gmail_thread_id).toBe("thread-abc-123")
    })

    it("stores null thread_id for new emails", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      const id = randomUUID()
      const now = new Date().toISOString()

      db.prepare(
        "INSERT INTO drafts (id, to_email, subject, body, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
      ).run(id, "new@test.com", "First contact", "Hi!", now)

      const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRecord
      expect(draft.gmail_thread_id).toBeNull()
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
  // Platform config
  // =========================================================================
  describe("Platform config", () => {
    it("MODULE_CONFIG has correct values", async () => {
      const { MODULE_CONFIG } = await import("../src/lib/types")
      expect(MODULE_CONFIG.provider).toBe("google")
      expect(MODULE_CONFIG.destination).toBe("google")
      expect(MODULE_CONFIG.name).toBe("Gmail")
    })
  })

  // =========================================================================
  // Google API integration (only with GOOGLE_TEST_TOKEN)
  // =========================================================================
  describe.skipIf(!process.env.GOOGLE_TEST_TOKEN)("Gmail API integration", () => {
    beforeAll(() => {
      process.env.PLATFORM_INTEGRATION_TOKEN = process.env.GOOGLE_TEST_TOKEN!
    })

    it("lists threads for a known email", async () => {
      const testEmail = process.env.GOOGLE_TEST_EMAIL
      if (!testEmail) throw new Error("GOOGLE_TEST_EMAIL required")

      const { listThreads } = await import("../src/server/google-api")
      const threads = await listThreads(`from:${testEmail} OR to:${testEmail}`, 5)
      expect(Array.isArray(threads)).toBe(true)
    })

    it("searches emails by query", async () => {
      const { searchEmails } = await import("../src/server/google-api")
      const results = await searchEmails("in:inbox", 3)
      expect(Array.isArray(results)).toBe(true)
    })
  })
})

async function waitForServer(url: string, timeoutMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`)
}
