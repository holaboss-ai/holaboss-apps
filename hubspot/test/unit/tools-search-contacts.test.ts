import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/hubspot-client"
import { buildSearchBody, searchContactsImpl } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("buildSearchBody", () => {
  it("translates EQ filter to filterGroups with propertyName + value", () => {
    const body = buildSearchBody({
      filters: [{ property: "lifecyclestage", operator: "EQ", value: "lead" }],
      limit: 25,
    })
    expect(body).toEqual({
      filterGroups: [
        {
          filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "lead" }],
        },
      ],
      limit: 25,
    })
  })

  it("translates IN filter using values array", () => {
    const body = buildSearchBody({
      filters: [{ property: "lifecyclestage", operator: "IN", values: ["lead", "opportunity"] }],
    })
    expect(body.filterGroups[0].filters[0]).toEqual({
      propertyName: "lifecyclestage",
      operator: "IN",
      values: ["lead", "opportunity"],
    })
  })

  it("translates BETWEEN to value + highValue (HubSpot's documented shape)", () => {
    const body = buildSearchBody({
      filters: [
        { property: "lastmodifieddate", operator: "BETWEEN", values: ["1579514400000", "1642672800000"] },
      ],
    })
    expect(body.filterGroups[0].filters[0]).toEqual({
      propertyName: "lastmodifieddate",
      operator: "BETWEEN",
      value: "1579514400000",
      highValue: "1642672800000",
    })
  })

  it("HAS_PROPERTY emits no value/values/highValue", () => {
    const body = buildSearchBody({
      filters: [{ property: "email", operator: "HAS_PROPERTY" }],
    })
    expect(body.filterGroups[0].filters[0]).toEqual({
      propertyName: "email",
      operator: "HAS_PROPERTY",
    })
  })

  it("includes query, sorts, properties, after when provided", () => {
    const body = buildSearchBody({
      query: "alice",
      sorts: [{ property: "createdate", direction: "DESCENDING" }],
      properties: ["email", "firstname"],
      after: "cursor_xyz",
      limit: 50,
    })
    expect(body.query).toBe("alice")
    expect(body.sorts).toEqual([{ propertyName: "createdate", direction: "DESCENDING" }])
    expect(body.properties).toEqual(["email", "firstname"])
    expect(body.after).toBe("cursor_xyz")
    expect(body.limit).toBe(50)
  })

  it("emits empty filterGroups when no filters are passed", () => {
    const body = buildSearchBody({ query: "anything" })
    expect(body.filterGroups).toEqual([])
  })
})

describe("searchContactsImpl", () => {
  let bridge: MockBridge
  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("returns normalized contacts and forwards next_cursor from paging.next.after", async () => {
    bridge.whenPost("/crm/v3/objects/contacts/search").respond(200, {
      results: [
        { id: "1", properties: { email: "a@b.com" } },
        { id: "2", properties: { email: "c@d.com" } },
      ],
      paging: { next: { after: "cursor_next" } },
    })
    const r = await searchContactsImpl({ filters: [{ property: "email", operator: "HAS_PROPERTY" }] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.contacts).toHaveLength(2)
      expect(r.data.contacts[0]).toEqual({ id: "1", properties: { email: "a@b.com" } })
      expect(r.data.next_cursor).toBe("cursor_next")
    }
  })

  it("returns next_cursor: null when there's no next page", async () => {
    bridge.whenPost("/crm/v3/objects/contacts/search").respond(200, { results: [] })
    const r = await searchContactsImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.next_cursor).toBeNull()
  })

  it("round-trips an `after` cursor into the request body", async () => {
    bridge.whenPost("/crm/v3/objects/contacts/search").respond(200, { results: [] })
    await searchContactsImpl({ after: "cursor_in" })
    expect(bridge.calls).toHaveLength(1)
    const body = bridge.calls[0].body as { after?: string }
    expect(body.after).toBe("cursor_in")
  })
})
