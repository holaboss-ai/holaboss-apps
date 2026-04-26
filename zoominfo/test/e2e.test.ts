import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { MockBridge } from "./fixtures/mock-bridge"
import type { Server } from "node:http"

const MCP_PORT = 13191

describe("ZoomInfo Module E2E", () => {
  let mcpServer: Server | null = null
  let tmp: string

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "zoominfo-e2e-"))
    process.env.DB_PATH = path.join(tmp, "zoominfo-e2e.db")

    const { startMcpServer } = await import("../src/server/mcp")
    const { setBridgeClient } = await import("../src/server/zoominfo-client")
    const { getDb } = await import("../src/server/db")

    const bridge = new MockBridge()
    bridge.whenAny().respond(200, {})
    setBridgeClient(bridge.asClient())

    getDb()

    mcpServer = startMcpServer(MCP_PORT)
    await waitForServer(`http://localhost:${MCP_PORT}/mcp/health`)
  }, 15_000)

  afterAll(async () => {
    if (mcpServer) {
      await new Promise<void>((resolve) => mcpServer!.close(() => resolve()))
      mcpServer = null
    }
    const { closeDb } = await import("../src/server/db")
    const { setBridgeClient } = await import("../src/server/zoominfo-client")
    closeDb()
    setBridgeClient(null)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("MCP health endpoint is live", async () => {
    const r = await fetch(`http://localhost:${MCP_PORT}/mcp/health`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.status).toBe("ok")
  })

  it("search_contacts writes a success audit row", async () => {
    const { setBridgeClient } = await import("../src/server/zoominfo-client")
    const { searchContactsImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenPost("/search/contact").respond(200, {
      currentPage: 1,
      totalResults: 1,
      data: [{ id: "p_1", firstName: "Alice", lastName: "Johnson", jobTitle: "CMO" }],
    })
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("zoominfo_search_contacts", searchContactsImpl)
    const result = await wrapped({ job_titles: ["CMO"] })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    const match = rows.find((r) => r.tool_name === "zoominfo_search_contacts")
    expect(match).toBeDefined()
    expect(match!.outcome).toBe("success")
  })

  it("enrich_contact validation_failed writes an error audit row", async () => {
    const { setBridgeClient } = await import("../src/server/zoominfo-client")
    const { enrichContactImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("zoominfo_enrich_contact", enrichContactImpl)
    const result = await wrapped({})
    expect(result.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    const errorRow = rows.find(
      (r) => r.outcome === "error" && r.tool_name === "zoominfo_enrich_contact",
    )
    expect(errorRow).toBeDefined()
    expect(errorRow!.error_code).toBe("validation_failed")
  })

  it("not_connected propagates from broker failure", async () => {
    const { setBridgeClient } = await import("../src/server/zoominfo-client")
    const { searchContactsImpl } = await import("../src/server/tools")

    const bridge = new MockBridge()
    bridge.whenAny().throwOnce(new Error("No zoominfo integration configured. Connect via Integrations settings."))
    setBridgeClient(bridge.asClient())

    const result = await searchContactsImpl({ job_titles: ["CTO"] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("not_connected")
  })
})

async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Server not ready at ${url} after ${timeoutMs}ms`)
}
