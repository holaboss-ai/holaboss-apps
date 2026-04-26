import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/apollo-client"
import {
  getOrganizationImpl,
  listEmailsSentImpl,
  searchOrganizationsImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("apollo organization + email tools", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("apollo_search_organizations hits /mixed_companies/search and maps tech_names", async () => {
    bridge.whenPost("/mixed_companies/search").respond(200, {
      organizations: [
        {
          id: "o_1",
          name: "Acme",
          primary_domain: "acme.com",
          industry: "saas",
          estimated_num_employees: 250,
          technology_names: ["snowflake", "salesforce"],
        },
      ],
    })
    const r = await searchOrganizationsImpl({
      industries: ["saas"],
      technologies: ["snowflake"],
      organization_locations: ["California, US"],
    })
    expect(r.ok).toBe(true)
    const body = bridge.calls[0].body as Record<string, unknown>
    expect(body.organization_industry_tag_ids).toEqual(["saas"])
    expect(body.currently_using_any_of_technology_uids).toEqual(["snowflake"])
    if (r.ok) {
      expect(r.data.organizations[0].technology_names).toEqual(["snowflake", "salesforce"])
      expect(r.data.organizations[0].estimated_num_employees).toBe(250)
    }
  })

  it("apollo_get_organization hits GET /organizations/:id and returns not_found on missing payload", async () => {
    bridge.whenGet("/organizations/o_missing").respond(200, {})
    const r = await getOrganizationImpl({ organization_id: "o_missing" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_found")
  })

  it("apollo_get_organization returns the parsed organization on success", async () => {
    bridge.whenGet("/organizations/o_1").respond(200, {
      organization: { id: "o_1", name: "Acme", primary_domain: "acme.com" },
    })
    const r = await getOrganizationImpl({ organization_id: "o_1" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.organization.id).toBe("o_1")
      expect(r.data.apollo_deep_link).toContain("/organizations/o_1")
    }
  })

  it("apollo_list_emails_sent rejects when neither contact_id nor sequence_id supplied", async () => {
    const r = await listEmailsSentImpl({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("validation_failed")
    expect(bridge.calls).toHaveLength(0)
  })

  it("apollo_list_emails_sent maps response and forwards status filter", async () => {
    bridge.whenPost("/emailer_messages/search").respond(200, {
      emailer_messages: [
        {
          id: "e_1",
          contact_id: "c_1",
          emailer_campaign_id: "s_1",
          subject: "Hello",
          status: "replied",
          sent_at: "2026-04-20T00:00:00Z",
          replied_at: "2026-04-21T00:00:00Z",
        },
      ],
    })
    const r = await listEmailsSentImpl({ contact_id: "c_1", status: "replied" })
    expect(r.ok).toBe(true)
    const body = bridge.calls[0].body as Record<string, unknown>
    expect(body.contact_ids).toEqual(["c_1"])
    expect(body.email_status).toBe("replied")
    if (r.ok) {
      expect(r.data.emails[0].status).toBe("replied")
      expect(r.data.emails[0].replied_at).toBe("2026-04-21T00:00:00Z")
    }
  })
})
