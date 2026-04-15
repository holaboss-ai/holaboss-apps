import { beforeEach, describe, expect, it } from "vitest"

import { call, setBridgeClient } from "../../src/server/calcom-client"
import { MockBridge } from "../fixtures/mock-bridge"

describe("calcom-client.call", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("returns ok for 2xx", async () => {
    bridge.whenGet("/v2/event-types").respond(200, { status: "success", data: [{ id: 1 }] })
    const r = await call<{ data: Array<{ id: number }> }>("GET", "/event-types")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.data[0].id).toBe(1)
  })

  it("maps 400 to validation_failed with Cal.com-shaped error", async () => {
    bridge.whenPost("/v2/bookings/bk_1/cancel").respond(400, {
      status: "error",
      error: { message: "Cannot cancel past booking", code: "INVALID_STATE" },
    })
    const r = await call("POST", "/bookings/bk_1/cancel", {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("Cannot cancel")
    }
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge.whenGet("/v2/bookings").respond(429, { error: "slow down" }, { "retry-after": "45" })
    const r = await call("GET", "/bookings")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(45)
    }
  })

  it("maps 5xx to upstream_error", async () => {
    bridge.whenGet("/v2/event-types").respond(503, {})
    const r = await call("GET", "/event-types")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps 'no cal integration' thrown error to not_connected", async () => {
    bridge.whenAny().throwOnce(new Error("No cal integration configured. Connect via Integrations settings."))
    const r = await call("GET", "/event-types")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps other thrown errors to upstream_error", async () => {
    bridge.whenAny().throwOnce(new Error("ECONNREFUSED"))
    const r = await call("GET", "/event-types")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })
})