import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MCP_PORT = 13093

describe("Instantly Module E2E", () => {
  let mcpServer: Server | null = null
  let tmp: string

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "instantly-e2e-"))
    process.env.DB_PATH = path.join(tmp, "instantly-e2e.db")

    const { startMcpServer } = await import("../src/server/mcp")
    const { setBridgeClient } = await import("../src/server/instantly-client")
    const { getDb } = await import("../src/server/db")

    const { MockBridge } = await import("./fixtures/mock-bridge")

    const bridge = new MockBridge()
    bridge.whenGet("/api/v2/workspaces/current").respond(200, { name: "Test Workspace" })
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
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("MCP health endpoint is live", async () => {
    const r = await fetch(`http://localhost:${MCP_PORT}/mcp/health`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.status).toBe("ok")
  })

  it("get_connection_status writes a success audit row", async () => {
    const { setBridgeClient } = await import("../src/server/instantly-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { getConnectionStatusImpl } = await import("../src/server/tools")
    const { listRecentActions, wrapTool } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenGet("/api/v2/workspaces/current").respond(200, { name: "WS-1" })
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("instantly_get_connection_status", getConnectionStatusImpl)
    const result = await wrapped({})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.connected).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    const match = rows.find((r) => r.tool_name === "instantly_get_connection_status")
    expect(match).toBeDefined()
    expect(match!.outcome).toBe("success")
  })

  it("not_connected response writes an audit row with code", async () => {
    const { setBridgeClient } = await import("../src/server/instantly-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { listCampaignsImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenAny().throwOnce(new Error("No instantly integration configured"))
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("instantly_list_campaigns", listCampaignsImpl)
    const result = await wrapped({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("not_connected")

    const rows = listRecentActions({ limit: 10 })
    const errRow = rows.find(
      (r) => r.tool_name === "instantly_list_campaigns" && r.error_code === "not_connected",
    )
    expect(errRow).toBeDefined()
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
