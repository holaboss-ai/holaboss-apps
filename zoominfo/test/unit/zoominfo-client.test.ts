import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { call, setBridgeClient } from "../../src/server/zoominfo-client"
import { MockBridge } from "../fixtures/mock-bridge"

const ZOOMINFO_BASE = "https://api.zoominfo.com"

describe("zoominfo-client.call", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    setBridgeClient(null)
  })

  it("forwards method + endpoint + body to the broker proxy", async () => {
    bridge.whenPost("/search/contact").respond(200, { data: [{ id: "p_1" }] })
    await call("POST", "/search/contact", { rpp: 25 })
    expect(bridge.calls).toHaveLength(1)
    expect(bridge.calls[0].method).toBe("POST")
    expect(bridge.calls[0].endpoint).toBe(`${ZOOMINFO_BASE}/search/contact`)
    expect(bridge.calls[0].body).toEqual({ rpp: 25 })
  })

  it("returns ok for 2xx", async () => {
    bridge.whenPost("/search/contact").respond(200, { data: [{ id: "p_1" }] })
    const r = await call<{ data: Array<{ id: string }> }>("POST", "/search/contact", {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.data[0].id).toBe("p_1")
  })

  it("maps 401 to not_connected", async () => {
    bridge.whenPost("/search/contact").respond(401, { error: "expired" })
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps 403 to not_connected", async () => {
    bridge.whenPost("/search/contact").respond(403, { error: "forbidden" })
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps 404 to not_found", async () => {
    bridge.whenGet("/contact/123").respond(404, { error: "not found" })
    const r = await call("GET", "/contact/123")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_found")
  })

  it("maps 400 to validation_failed with body message", async () => {
    bridge.whenPost("/search/contact").respond(400, { message: "Invalid jobTitle" })
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("Invalid")
    }
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge.whenPost("/search/contact").respond(429, { error: "slow down" }, { "retry-after": "30" })
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(30)
    }
  })

  it("maps 5xx to upstream_error", async () => {
    bridge.whenPost("/search/contact").respond(503, { error: "boom" })
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps a not-connected broker error to not_connected", async () => {
    bridge.whenAny().throwOnce(new Error("No zoominfo integration configured. Connect via Integrations settings."))
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps an arbitrary broker exception to upstream_error", async () => {
    bridge.whenAny().throwOnce(new Error("network down"))
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })
})
