import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/apollo-client"
import { searchPeopleImpl } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("apollo_search_people", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("hits POST /mixed_people/api_search and forwards filters", async () => {
    bridge.whenPost("/mixed_people/api_search").respond(200, {
      people: [
        {
          id: "p_1",
          first_name: "Jane",
          last_name: "Smith",
          name: "Jane Smith",
          title: "VP Engineering",
          organization: { id: "o_1", name: "Acme", primary_domain: "acme.com" },
          city: "San Francisco",
        },
      ],
      pagination: { page: 1, per_page: 25, total_entries: 1, total_pages: 1 },
    })

    const r = await searchPeopleImpl({
      person_titles: ["VP Engineering"],
      organization_domains: ["acme.com"],
      person_locations: ["California, US"],
      per_page: 25,
    })

    expect(r.ok).toBe(true)
    expect(bridge.calls[0].endpoint).toContain("/mixed_people/api_search")
    const sentBody = bridge.calls[0].body as Record<string, unknown>
    expect(sentBody.person_titles).toEqual(["VP Engineering"])
    expect(sentBody.q_organization_domains_list).toEqual(["acme.com"])
    expect(sentBody.person_locations).toEqual(["California, US"])
    expect(sentBody.per_page).toBe(25)

    if (r.ok) {
      expect(r.data.people).toHaveLength(1)
      expect(r.data.people[0].id).toBe("p_1")
      expect(r.data.people[0].title).toBe("VP Engineering")
      expect(r.data.people[0].organization?.domain).toBe("acme.com")
      expect(r.data.pagination?.total_entries).toBe(1)
    }
  })

  it("clamps per_page to 100 when caller asks for more", async () => {
    bridge.whenPost("/mixed_people/api_search").respond(200, { people: [] })
    await searchPeopleImpl({ per_page: 500 })
    const sentBody = bridge.calls[0].body as Record<string, unknown>
    expect(sentBody.per_page).toBe(100)
  })

  it("returns email=null when Apollo omits it (free-tier behavior)", async () => {
    bridge.whenPost("/mixed_people/api_search").respond(200, {
      people: [{ id: "p_1", first_name: "Jane", last_name: "Smith" }],
    })
    const r = await searchPeopleImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.people[0].email).toBeNull()
  })

  it("propagates rate_limited errors", async () => {
    bridge
      .whenPost("/mixed_people/api_search")
      .respond(429, {}, { "retry-after": "60" })
    const r = await searchPeopleImpl({})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(60)
    }
  })
})
