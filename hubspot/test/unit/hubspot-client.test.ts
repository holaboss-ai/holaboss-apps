import { beforeEach, describe, expect, it } from "vitest"

import { call, setBridgeClient } from "../../src/server/hubspot-client"
import { MockBridge } from "../fixtures/mock-bridge"

describe("hubspot-client.call", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("returns ok for 2xx", async () => {
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 12345 })
    const r = await call<{ portalId: number }>("GET", "/account-info/v3/details")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.portalId).toBe(12345)
  })

  it("maps 401 to not_connected", async () => {
    bridge.whenGet("/crm/v3/objects/contacts/1").respond(401, { message: "Token expired" })
    const r = await call("GET", "/crm/v3/objects/contacts/1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("not_connected")
      expect(r.error.message).toContain("Token expired")
    }
  })

  it("maps 403 to not_connected with scope-missing message extracted", async () => {
    bridge.whenGet("/crm/v3/objects/deals/1").respond(403, {
      message: "This app is missing required scopes.",
      category: "MISSING_SCOPES",
      context: {
        requiredScopes: ["crm.objects.deals.read", "crm.objects.deals.write"],
      },
    })
    const r = await call("GET", "/crm/v3/objects/deals/1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("not_connected")
      expect(r.error.message).toContain("scope missing")
      expect(r.error.message).toContain("crm.objects.deals.read")
      expect(r.error.message).toContain("crm.objects.deals.write")
    }
  })

  it("maps 404 to not_found", async () => {
    bridge.whenGet("/crm/v3/objects/contacts/999").respond(404, { message: "Not found" })
    const r = await call("GET", "/crm/v3/objects/contacts/999")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_found")
  })

  it("maps 400 to validation_failed with message from body", async () => {
    bridge.whenPost("/crm/v3/objects/contacts").respond(400, {
      message: "Property 'email' is required",
    })
    const r = await call("POST", "/crm/v3/objects/contacts", { properties: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("email")
    }
  })

  it("maps 429 to rate_limited with retry_after; does not auto-retry", async () => {
    bridge
      .whenGet("/crm/v3/properties/contacts")
      .respond(429, { message: "Too many requests" }, { "retry-after": "30" })
    const r = await call("GET", "/crm/v3/properties/contacts")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(30)
    }
    // exactly one upstream call — no auto-retry per Plan §10.
    expect(bridge.calls).toHaveLength(1)
  })

  it("maps 500 to upstream_error", async () => {
    bridge.whenGet("/crm/v3/properties/contacts").respond(503, { message: "boom" })
    const r = await call("GET", "/crm/v3/properties/contacts")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps 'no hubspot integration' thrown error to not_connected", async () => {
    bridge
      .whenAny()
      .throwOnce(new Error("No hubspot integration configured. Connect via Integrations settings."))
    const r = await call("GET", "/crm/v3/objects/contacts")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps other thrown errors to upstream_error", async () => {
    bridge.whenAny().throwOnce(new Error("ECONNREFUSED"))
    const r = await call("GET", "/crm/v3/objects/contacts")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })
})
