import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MCP_PORT = 13192

describe("HubSpot Module E2E", () => {
  let mcpServer: Server | null = null
  let tmp: string

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "hubspot-e2e-"))
    process.env.DB_PATH = path.join(tmp, "hubspot-e2e.db")

    const { startMcpServer } = await import("../src/server/mcp")
    const { setBridgeClient } = await import("../src/server/hubspot-client")
    const { getDb } = await import("../src/server/db")
    const { resetPortalIdCacheForTests } = await import("../src/server/tools")

    const { MockBridge } = await import("./fixtures/mock-bridge")

    const bridge = new MockBridge()
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 99 })
    setBridgeClient(bridge.asClient())
    resetPortalIdCacheForTests()

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

  it("get_connection_status round-trips through the audit table", async () => {
    const { setBridgeClient } = await import("../src/server/hubspot-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { getConnectionStatusImpl, resetPortalIdCacheForTests } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 777 })
    setBridgeClient(bridge.asClient())
    resetPortalIdCacheForTests()

    const wrapped = wrapTool("hubspot_get_connection_status", getConnectionStatusImpl)
    const result = await wrapped({})
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    const match = rows.find((r) => r.tool_name === "hubspot_get_connection_status")
    expect(match).toBeDefined()
    expect(match!.outcome).toBe("success")
  })

  it("describe_schema writes a success audit row", async () => {
    const { setBridgeClient } = await import("../src/server/hubspot-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { describeSchemaImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenGet("/crm/v3/properties/contacts").respond(200, {
      results: [{ name: "email", label: "Email", type: "string", fieldType: "text" }],
    })
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("hubspot_describe_schema", describeSchemaImpl)
    const result = await wrapped({ object_type: "contacts" })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 20 })
    const match = rows.find((r) => r.tool_name === "hubspot_describe_schema")
    expect(match).toBeDefined()
    expect(match!.outcome).toBe("success")
    expect(match!.result_summary).toContain("Described")
  })

  it("not_connected short-circuits before bridge call", async () => {
    const { setBridgeClient } = await import("../src/server/hubspot-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { createContactImpl, resetPortalIdCacheForTests } = await import("../src/server/tools")

    const bridge = new MockBridge()
    bridge.whenAny().throwOnce(new Error("No hubspot integration configured"))
    setBridgeClient(bridge.asClient())
    resetPortalIdCacheForTests()

    const result = await createContactImpl({ properties: { email: "x@y.com" } })
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
