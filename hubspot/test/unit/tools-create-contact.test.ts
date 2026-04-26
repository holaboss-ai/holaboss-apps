import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/hubspot-client"
import {
  createContactImpl,
  resetPortalIdCacheForTests,
  updateContactImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("createContactImpl", () => {
  let bridge: MockBridge
  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
    resetPortalIdCacheForTests()
  })

  it("POSTs properties + builds contact→company association (typeId 1) when given", async () => {
    bridge.whenPost("/crm/v3/objects/contacts").respond(201, { id: "cnt_123" })
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 9 })

    const r = await createContactImpl({
      properties: { email: "alice@acme.com", firstname: "Alice" },
      associations: [{ to_object_type: "companies", to_object_id: "co_1" }],
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.contact_id).toBe("cnt_123")
      expect(r.data.hubspot_deep_link).toBe("https://app.hubspot.com/contacts/9/contact/cnt_123")
    }

    const post = bridge.calls.find((c) => c.method === "POST")!
    const body = post.body as {
      properties: Record<string, unknown>
      associations: Array<{ to: { id: string }; types: Array<{ associationTypeId: number }> }>
    }
    expect(body.properties.email).toBe("alice@acme.com")
    expect(body.associations[0].to).toEqual({ id: "co_1" })
    expect(body.associations[0].types[0].associationTypeId).toBe(1)
  })

  it("propagates validation_failed on duplicate email (HubSpot 409/400)", async () => {
    bridge
      .whenPost("/crm/v3/objects/contacts")
      .respond(409, { message: "Contact already exists with email alice@acme.com" })

    const r = await createContactImpl({
      properties: { email: "alice@acme.com" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("already exists")
    }
  })
})

describe("updateContactImpl idempotency", () => {
  let bridge: MockBridge
  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
    resetPortalIdCacheForTests()
  })

  it("re-applying the same property map returns success both times", async () => {
    bridge
      .whenPatch("/crm/v3/objects/contacts/55")
      .respond(200, { id: "55", properties: { lifecyclestage: "opportunity" } })
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 9 })

    const a = await updateContactImpl({
      contact_id: "55",
      properties: { lifecyclestage: "opportunity" },
    })
    const b = await updateContactImpl({
      contact_id: "55",
      properties: { lifecyclestage: "opportunity" },
    })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.data.contact_id).toBe(b.data.contact_id)
      expect(a.data.hubspot_deep_link).toBe(b.data.hubspot_deep_link)
    }
  })
})
