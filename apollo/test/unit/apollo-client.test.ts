import { beforeEach, describe, expect, it } from "vitest"

import { call, setBridgeClient } from "../../src/server/apollo-client"
import { MockBridge } from "../fixtures/mock-bridge"

describe("apollo-client.call", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("returns ok for 2xx and uses /api/v1 base", async () => {
    bridge.whenGet("/api/v1/auth/health").respond(200, { is_logged_in: true })
    const r = await call<{ is_logged_in: boolean }>("GET", "/auth/health")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.is_logged_in).toBe(true)
    expect(bridge.calls[0].endpoint).toBe("https://api.apollo.io/api/v1/auth/health")
  })

  it("maps 401/403 to not_connected", async () => {
    bridge.whenGet("/auth/health").respond(401, { error: "invalid api key" })
    const r = await call("GET", "/auth/health")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps 404 to not_found", async () => {
    bridge.whenGet("/organizations/x").respond(404, { message: "Org not found" })
    const r = await call("GET", "/organizations/x")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("not_found")
      expect(r.error.message).toContain("Org not found")
    }
  })

  it("maps 422 to validation_failed with body message", async () => {
    bridge.whenPost("/people/match").respond(422, { message: "Domain is required" })
    const r = await call("POST", "/people/match", { first_name: "A" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("Domain")
    }
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge
      .whenGet("/auth/health")
      .respond(429, { error: "slow down" }, { "retry-after": "30" })
    const r = await call("GET", "/auth/health")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(30)
    }
  })

  it("maps 503 to upstream_error", async () => {
    bridge.whenGet("/auth/health").respond(503, { error: "boom" })
    const r = await call("GET", "/auth/health")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps 'not connected' thrown error to not_connected", async () => {
    bridge
      .whenAny()
      .throwOnce(new Error("No apollo integration configured. Connect via Integrations settings."))
    const r = await call("GET", "/auth/health")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("extracts message from errors[] array form", async () => {
    bridge
      .whenPost("/people/match")
      .respond(422, { errors: [{ message: "Email malformed" }] })
    const r = await call("POST", "/people/match", { email: "x" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain("Email malformed")
  })
})
