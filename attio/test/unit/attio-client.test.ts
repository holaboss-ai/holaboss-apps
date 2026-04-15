import { beforeEach, describe, expect, it } from "vitest"

import { call, setBridgeClient } from "../../src/server/attio-client"
import { MockBridge } from "../fixtures/mock-bridge"

describe("attio-client.call", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("returns ok for 2xx", async () => {
    bridge.whenGet("/v2/objects").respond(200, { data: [{ slug: "people" }] })
    const r = await call<{ data: Array<{ slug: string }> }>("GET", "/objects")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.data[0].slug).toBe("people")
  })

  it("maps 400 to validation_failed with message from body", async () => {
    bridge.whenPost("/v2/objects/people/records").respond(400, {
      message: "Attribute 'industry' is required",
    })
    const r = await call("POST", "/objects/people/records", { values: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("industry")
    }
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge.whenGet("/v2/objects").respond(429, { error: "slow down" }, { "retry-after": "30" })
    const r = await call("GET", "/objects")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(30)
    }
  })

  it("maps 500 to upstream_error", async () => {
    bridge.whenGet("/v2/objects").respond(503, { error: "boom" })
    const r = await call("GET", "/objects")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps 'not connected' thrown error to not_connected", async () => {
    bridge.whenAny().throwOnce(new Error("No attio integration configured. Connect via Integrations settings."))
    const r = await call("GET", "/objects")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps other thrown errors to upstream_error", async () => {
    bridge.whenAny().throwOnce(new Error("ECONNREFUSED"))
    const r = await call("GET", "/objects")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })
})