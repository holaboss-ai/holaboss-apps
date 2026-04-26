import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/apollo-client"
import { enrichPersonImpl } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("apollo_enrich_person", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("rejects calls with no identifier trio / email / linkedin_url", async () => {
    const r = await enrichPersonImpl({})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toMatch(/Provide one of/)
    }
    expect(bridge.calls).toHaveLength(0)
  })

  it("hits POST /people/match with name + domain trio", async () => {
    bridge.whenPost("/people/match").respond(200, {
      person: {
        id: "p_99",
        name: "Jane Smith",
        first_name: "Jane",
        last_name: "Smith",
        email: "jane@acme.com",
        organization: { id: "o_1", name: "Acme", primary_domain: "acme.com" },
      },
      credits_consumed: 1,
    })

    const r = await enrichPersonImpl({
      first_name: "Jane",
      last_name: "Smith",
      organization_domain: "acme.com",
    })

    expect(r.ok).toBe(true)
    const sentBody = bridge.calls[0].body as Record<string, unknown>
    expect(sentBody.first_name).toBe("Jane")
    expect(sentBody.domain).toBe("acme.com")
    expect(sentBody.reveal_personal_emails).toBe(true)
    expect(sentBody.reveal_phone_number).toBe(false)
    if (r.ok) {
      expect(r.data.person.email).toBe("jane@acme.com")
      expect(r.data.credits_consumed).toBe(1)
      expect(r.data.apollo_deep_link).toContain("/people/p_99")
    }
  })

  it("returns not_found when Apollo can't match", async () => {
    bridge.whenPost("/people/match").respond(200, {})
    const r = await enrichPersonImpl({ email: "nobody@nowhere.com" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_found")
  })

  it("accepts linkedin_url alone", async () => {
    bridge.whenPost("/people/match").respond(200, {
      person: { id: "p_1", first_name: "X", last_name: "Y" },
    })
    const r = await enrichPersonImpl({ linkedin_url: "https://linkedin.com/in/foo" })
    expect(r.ok).toBe(true)
    const sentBody = bridge.calls[0].body as Record<string, unknown>
    expect(sentBody.linkedin_url).toBe("https://linkedin.com/in/foo")
  })
})
