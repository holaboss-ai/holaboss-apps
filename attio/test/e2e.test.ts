import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MCP_PORT = 13091

describe("Attio Module E2E", () => {
  let mcpServer: Server | null = null
  let tmp: string

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-e2e-"))
    process.env.DB_PATH = path.join(tmp, "attio-e2e.db")

    const { startMcpServer } = await import("../src/server/mcp")
    const { setBridgeClient } = await import("../src/server/attio-client")
    const { getDb } = await import("../src/server/db")

    const { MockBridge } = await import("./fixtures/mock-bridge")

    const bridge = new MockBridge()
    bridge.whenGet("/v2/self").respond(200, { data: { workspace_name: "Test WS" } })
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

  it("create_person writes an audit row", async () => {
    const { setBridgeClient } = await import("../src/server/attio-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { createPersonImpl } = await import("../src/server/tools")
    const { listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenPost("/v2/objects/people/records").respond(200, {
      data: { id: { record_id: "rec_e2e_1" } },
    })
    setBridgeClient(bridge.asClient())

    const { wrapTool } = await import("../src/server/audit")
    const wrapped = wrapTool("attio_create_person", createPersonImpl)
    const result = await wrapped({ attributes: { name: "E2E User" } })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    const match = rows.find((r) => r.attio_record_id === "rec_e2e_1")
    expect(match).toBeDefined()
    expect(match!.outcome).toBe("success")
  })

  it("tool failure writes an error audit row", async () => {
    const { setBridgeClient } = await import("../src/server/attio-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { createPersonImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenPost("/v2/objects/people/records").respond(422, {
      message: "Required attribute missing",
    })
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("attio_create_person", createPersonImpl)
    const result = await wrapped({ attributes: {} })
    expect(result.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    const errorRow = rows.find((r) => r.outcome === "error" && r.error_code === "validation_failed")
    expect(errorRow).toBeDefined()
    expect(errorRow!.error_message).toContain("Required")
  })

  it("not_connected short-circuits before bridge call", async () => {
    const { setBridgeClient } = await import("../src/server/attio-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { createPersonImpl } = await import("../src/server/tools")

    const bridge = new MockBridge()
    bridge.whenAny().throwOnce(new Error("No attio integration configured"))
    setBridgeClient(bridge.asClient())

    const result = await createPersonImpl({ attributes: { name: "X" } })
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