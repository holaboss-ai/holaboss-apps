import { beforeEach, describe, expect, it } from "vitest"

import { call, setBridgeClient } from "../../src/server/instantly-client"
import { MockBridge } from "../fixtures/mock-bridge"

describe("instantly-client.call", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("returns ok for 2xx", async () => {
    bridge.whenGet("/api/v2/campaigns").respond(200, { items: [{ id: "cmp_1" }] })
    const r = await call<{ items: Array<{ id: string }> }>("GET", "/campaigns")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.items[0].id).toBe("cmp_1")
  })

  it("maps 400 to validation_failed with message from body", async () => {
    bridge.whenPost("/api/v2/campaigns").respond(400, {
      message: "name is required",
    })
    const r = await call("POST", "/campaigns", {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("required")
    }
  })

  it("maps 401 to not_connected", async () => {
    bridge.whenGet("/api/v2/workspaces/current").respond(401, { error: "unauthorized" })
    const r = await call("GET", "/workspaces/current")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps 404 to not_found", async () => {
    bridge.whenGet("/api/v2/campaigns/x").respond(404, { message: "not found" })
    const r = await call("GET", "/campaigns/x")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_found")
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge.whenGet("/api/v2/campaigns").respond(429, { error: "slow down" }, { "retry-after": "30" })
    const r = await call("GET", "/campaigns")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(30)
    }
  })

  it("maps 503 to upstream_error", async () => {
    bridge.whenGet("/api/v2/campaigns").respond(503, { error: "boom" })
    const r = await call("GET", "/campaigns")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps 'not connected' thrown error to not_connected", async () => {
    bridge
      .whenAny()
      .throwOnce(new Error("No instantly integration configured. Connect via Integrations settings."))
    const r = await call("GET", "/campaigns")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps other thrown errors to upstream_error", async () => {
    bridge.whenAny().throwOnce(new Error("ECONNREFUSED"))
    const r = await call("GET", "/campaigns")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })
})
