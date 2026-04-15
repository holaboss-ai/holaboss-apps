import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MCP_PORT = 13092

describe("Cal.com Module E2E", () => {
  let mcpServer: Server | null = null
  let tmp: string

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "calcom-e2e-"))
    process.env.DB_PATH = path.join(tmp, "calcom-e2e.db")

    const { startMcpServer } = await import("../src/server/mcp")
    const { setBridgeClient } = await import("../src/server/calcom-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")

    const bridge = new MockBridge()
    bridge.whenGet("/v2/event-types").respond(200, {
      status: "success",
      data: [{ id: 1, slug: "30min", title: "Intro", lengthInMinutes: 30 }],
    })
    setBridgeClient(bridge.asClient())

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
    expect(((await r.json()) as { status: string }).status).toBe("ok")
  })

  it("list_event_types success writes an audit row", async () => {
    const { setBridgeClient } = await import("../src/server/calcom-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { listEventTypesImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenGet("/v2/event-types").respond(200, {
      status: "success",
      data: [{ id: 1, slug: "30min", title: "Intro", lengthInMinutes: 30, schedulingUrl: "https://cal.com/josh/30min" }],
    })
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("calcom_list_event_types", listEventTypesImpl)
    const r = await wrapped({})
    expect(r.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    const match = rows.find((row) => row.tool_name === "calcom_list_event_types" && row.outcome === "success")
    expect(match).toBeDefined()
  })

  it("cancel_booking 400 writes an error audit row", async () => {
    const { setBridgeClient } = await import("../src/server/calcom-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { cancelBookingImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenPost("/v2/bookings/bk_past/cancel").respond(400, {
      status: "error",
      error: { message: "Cannot cancel past booking" },
    })
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("calcom_cancel_booking", cancelBookingImpl)
    const r = await wrapped({ booking_id: "bk_past", reason: "test" })
    expect(r.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    const errorRow = rows.find((row) => row.outcome === "error" && row.error_code === "validation_failed")
    expect(errorRow).toBeDefined()
    expect(errorRow!.error_message).toContain("past")
  })

  it("not_connected short-circuits before bridge call", async () => {
    const { setBridgeClient } = await import("../src/server/calcom-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { listEventTypesImpl } = await import("../src/server/tools")

    const bridge = new MockBridge()
    bridge.whenAny().throwOnce(new Error("No cal integration configured"))
    setBridgeClient(bridge.asClient())

    const r = await listEventTypesImpl({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
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
