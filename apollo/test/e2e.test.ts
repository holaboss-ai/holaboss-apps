import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MCP_PORT = 13092

describe("Apollo Module E2E", () => {
  let mcpServer: Server | null = null
  let tmp: string

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "apollo-e2e-"))
    process.env.DB_PATH = path.join(tmp, "apollo-e2e.db")

    const { startMcpServer } = await import("../src/server/mcp")
    const { setBridgeClient } = await import("../src/server/apollo-client")
    const { getDb } = await import("../src/server/db")

    const { MockBridge } = await import("./fixtures/mock-bridge")

    const bridge = new MockBridge()
    bridge.whenGet("/auth/health").respond(200, {
      is_logged_in: true,
      is_master_key: true,
      user: { email: "user@acme.com" },
      team: { name: "Acme Sales" },
    })
    bridge.whenPost("/mixed_people/api_search").respond(200, {
      people: [
        { id: "p_e2e_1", first_name: "Jane", last_name: "Smith", title: "VP Engineering" },
      ],
    })
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

  it("get_connection_status writes an audit row and reports the team", async () => {
    const { getConnectionStatusImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const wrapped = wrapTool("apollo_get_connection_status", getConnectionStatusImpl)
    const result = await wrapped({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.connected).toBe(true)
      expect(result.data.team_name).toBe("Acme Sales")
    }
    const rows = listRecentActions({ limit: 10 })
    const match = rows.find((r) => r.tool_name === "apollo_get_connection_status")
    expect(match).toBeDefined()
    expect(match!.outcome).toBe("success")
  })

  it("search_people round-trip returns normalized person records", async () => {
    const { searchPeopleImpl } = await import("../src/server/tools")
    const { wrapTool } = await import("../src/server/audit")

    const wrapped = wrapTool("apollo_search_people", searchPeopleImpl)
    const r = await wrapped({ person_titles: ["VP Engineering"] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.people).toHaveLength(1)
      expect(r.data.people[0].id).toBe("p_e2e_1")
    }
  })

  it("not_connected propagates as a typed error", async () => {
    const { setBridgeClient } = await import("../src/server/apollo-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { getConnectionStatusImpl } = await import("../src/server/tools")

    const bridge = new MockBridge()
    bridge.whenAny().throwOnce(new Error("No apollo integration configured"))
    setBridgeClient(bridge.asClient())

    const result = await getConnectionStatusImpl({})
    // get_connection_status maps not_connected → ok with connected=false
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.connected).toBe(false)
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
