import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/apollo-client"
import { getConnectionStatusImpl, getPersonImpl } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("apollo connection + get_person", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("get_connection_status returns connected=true on 200", async () => {
    bridge.whenGet("/auth/health").respond(200, {
      is_logged_in: true,
      is_master_key: true,
      user: { email: "user@acme.com" },
      team: { name: "Acme Sales" },
    })
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.connected).toBe(true)
      expect(r.data.user_email).toBe("user@acme.com")
      expect(r.data.team_name).toBe("Acme Sales")
      expect(r.data.is_master_key).toBe(true)
    }
  })

  it("get_connection_status returns connected=false on 401", async () => {
    bridge.whenGet("/auth/health").respond(401, { error: "bad key" })
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.connected).toBe(false)
  })

  it("get_person uses POST /people/match with id + reveal flags off (no credit cost)", async () => {
    bridge.whenPost("/people/match").respond(200, {
      person: { id: "p_1", first_name: "Jane", last_name: "Smith" },
    })
    const r = await getPersonImpl({ person_id: "p_1" })
    expect(r.ok).toBe(true)
    const sentBody = bridge.calls[0].body as Record<string, unknown>
    expect(sentBody.id).toBe("p_1")
    expect(sentBody.reveal_personal_emails).toBe(false)
    expect(sentBody.reveal_phone_number).toBe(false)
    if (r.ok) {
      expect(r.data.person.id).toBe("p_1")
      expect(r.data.apollo_deep_link).toContain("/people/p_1")
    }
  })

  it("get_person returns not_found when Apollo can't match", async () => {
    bridge.whenPost("/people/match").respond(200, {})
    const r = await getPersonImpl({ person_id: "p_unknown" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_found")
  })
})
