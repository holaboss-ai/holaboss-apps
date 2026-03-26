import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"

let mcpServer: Server | null = null
const MCP_PORT = 13098
const TEST_DB_PATH = `/tmp/sheets-e2e-test-${Date.now()}.db`

describe("Sheets Module E2E", () => {
  beforeAll(async () => {
    process.env.DB_PATH = TEST_DB_PATH

    const { startMcpServer } = await import("../src/server/mcp")
    mcpServer = startMcpServer(MCP_PORT)
    await waitForServer(`http://localhost:${MCP_PORT}/health`)
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
    it("creates sync_state table on init", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
      const names = tables.map((t) => t.name)
      expect(names).toContain("sync_state")
    })

    it("stores and retrieves sync metadata", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()
      const now = new Date().toISOString()

      db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_sync_at', ?)").run(now)
      const row = db.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_at'").get() as { value: string }
      expect(row.value).toBe(now)
    })

    it("supports upsert on sync_state", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('sheet_id', 'abc')").run()
      db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('sheet_id', 'def')").run()

      const row = db.prepare("SELECT value FROM sync_state WHERE key = 'sheet_id'").get() as { value: string }
      expect(row.value).toBe("def")
    })
  })

  // =========================================================================
  // Google API client (unit tests, no real API)
  // =========================================================================
  describe("Google API client helpers", () => {
    it("colLetter converts column index to letter", async () => {
      const { colLetter } = await import("../src/server/google-api")
      expect(colLetter(1)).toBe("A")
      expect(colLetter(2)).toBe("B")
      expect(colLetter(26)).toBe("Z")
      expect(colLetter(27)).toBe("AA")
      expect(colLetter(28)).toBe("AB")
    })

    it("rejects when no token is set", async () => {
      const saved = process.env.PLATFORM_INTEGRATION_TOKEN
      delete process.env.PLATFORM_INTEGRATION_TOKEN

      const { readRows } = await import("../src/server/google-api")
      await expect(readRows("fake-sheet-id")).rejects.toThrow("PLATFORM_INTEGRATION_TOKEN")

      process.env.PLATFORM_INTEGRATION_TOKEN = saved
    })
  })

  // =========================================================================
  // MCP server
  // =========================================================================
  describe("MCP server", () => {
    it("health check responds ok", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/health`)
      expect(res.ok).toBe(true)
      expect((await res.json()).status).toBe("ok")
    })

    it("MCP endpoint accepts POST", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      })
      expect(res.status).toBe(200)
    })

    it("returns 404 for unknown paths", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/unknown`)
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
      expect(MODULE_CONFIG.name).toBe("Google Sheets")
    })
  })

  // =========================================================================
  // Google Sheets API integration (only with GOOGLE_TEST_TOKEN)
  // =========================================================================
  describe.skipIf(!process.env.GOOGLE_TEST_TOKEN)("Sheets API integration", () => {
    beforeAll(() => {
      process.env.PLATFORM_INTEGRATION_TOKEN = process.env.GOOGLE_TEST_TOKEN!
    })

    it("reads sheet info", async () => {
      const sheetId = process.env.GMAIL_CRM_SHEET_ID
      if (!sheetId) throw new Error("GMAIL_CRM_SHEET_ID required")

      const { getSheetInfo } = await import("../src/server/google-api")
      const info = await getSheetInfo(sheetId)
      expect(info.title).toBeDefined()
      expect(Array.isArray(info.headers)).toBe(true)
    })

    it("reads rows from sheet", async () => {
      const sheetId = process.env.GMAIL_CRM_SHEET_ID
      if (!sheetId) throw new Error("GMAIL_CRM_SHEET_ID required")

      const { readRows } = await import("../src/server/google-api")
      const rows = await readRows(sheetId)
      expect(Array.isArray(rows)).toBe(true)
      if (rows.length > 0) {
        expect(rows[0].values).toHaveProperty("email")
        expect(rows[0].rowNumber).toBeGreaterThanOrEqual(2)
      }
    })

    it("reads a specific range", async () => {
      const sheetId = process.env.GMAIL_CRM_SHEET_ID
      if (!sheetId) throw new Error("GMAIL_CRM_SHEET_ID required")

      const { readRange } = await import("../src/server/google-api")
      const cells = await readRange(sheetId, "Sheet1!A1:E1")
      expect(Array.isArray(cells)).toBe(true)
      expect(cells.length).toBeGreaterThanOrEqual(1)
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
