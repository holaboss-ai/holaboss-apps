import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { resetJwtCache, setBridgeClient } from "../../src/server/zoominfo-client"
import {
  enrichCompanyImpl,
  enrichContactImpl,
  getConnectionStatusImpl,
  getIntentImpl,
  getOrgChartImpl,
  searchCompaniesImpl,
  searchContactsImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("zoominfo tools", () => {
  let bridge: MockBridge
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "zoominfo-tools-"))
    resetDbForTests(path.join(tmp, "zoominfo.db"))
    getDb()
    bridge = new MockBridge()
    bridge.setCredentialPayload({ jwt: "test-jwt" })
    setBridgeClient(bridge.asClient())
    resetJwtCache()
    bridge.useGlobalFetchMock()
  })

  afterEach(() => {
    MockBridge.restoreGlobalFetch()
    setBridgeClient(null)
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  describe("get_connection_status", () => {
    it("returns connected:true on successful auth", async () => {
      // jwt cache is hot from setCredentialPayload({ jwt }) — no /authenticate call needed.
      const r = await getConnectionStatusImpl({})
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.connected).toBe(true)
    })

    it("returns connected:false when broker says not connected", async () => {
      bridge.failGetCredential(new Error("No zoominfo integration configured."))
      resetJwtCache()
      const r = await getConnectionStatusImpl({})
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.connected).toBe(false)
    })
  })

  describe("search_contacts", () => {
    it("maps job_titles + locations into ZoomInfo body shape", async () => {
      bridge.whenPost("/search/contact").respond(200, {
        currentPage: 1,
        totalResults: 2,
        data: [
          { id: "p_1", firstName: "Alice", lastName: "A", jobTitle: "CMO", country: "US", region: "CA" },
          { id: "p_2", firstName: "Bob", lastName: "B", jobTitle: "VP Marketing", country: "US", region: "NY" },
        ],
      })
      const r = await searchContactsImpl({
        job_titles: ["CMO", "VP Marketing"],
        management_levels: ["c_level", "vp_level"],
        locations: ["US-CA", "US-NY"],
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.data.contacts).toHaveLength(2)
        expect(r.data.contacts[0].first_name).toBe("Alice")
        expect(r.data.has_next).toBe(false)
      }
      const call = bridge.calls.find((c) => c.endpoint === "/search/contact")
      expect(call!.body).toMatchObject({
        page: 1,
        rpp: 25,
        jobTitle: "CMO,VP Marketing",
        managementLevel: "C-Level,VP-Level",
      })
    })

    it("clamps page_size to 100", async () => {
      bridge.whenPost("/search/contact").respond(200, { totalResults: 0, data: [] })
      const r = await searchContactsImpl({ page_size: 500 })
      expect(r.ok).toBe(true)
      const call = bridge.calls.find((c) => c.endpoint === "/search/contact")
      expect((call!.body as { rpp: number }).rpp).toBe(100)
    })

    it("computes has_next when totalResults exceeds current page", async () => {
      bridge.whenPost("/search/contact").respond(200, {
        totalResults: 100,
        data: [{ id: "p_1" }, { id: "p_2" }],
      })
      const r = await searchContactsImpl({ page: 1, page_size: 25 })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.has_next).toBe(true)
    })
  })

  describe("enrich_contact", () => {
    it("returns validation_failed when no usable input is supplied", async () => {
      const r = await enrichContactImpl({})
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe("validation_failed")
    })

    it("accepts contact_id alone", async () => {
      bridge.whenPost("/enrich/contact").respond(200, {
        data: {
          result: [
            {
              data: [
                {
                  id: "p_1",
                  firstName: "Alice",
                  lastName: "Johnson",
                  email: "alice@acme.com",
                  directPhoneDoNotCall: "+1-555-1234",
                },
              ],
            },
          ],
        },
      })
      const r = await enrichContactImpl({ contact_id: "p_1" })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.data.contact.email).toBe("alice@acme.com")
        expect(r.data.contact.direct_phone).toBe("+1-555-1234")
      }
    })

    it("accepts (first_name + last_name + company_domain)", async () => {
      bridge.whenPost("/enrich/contact").respond(200, {
        data: { result: [{ data: [{ id: "p_2", firstName: "Bob", lastName: "Smith" }] }] },
      })
      const r = await enrichContactImpl({
        first_name: "Bob",
        last_name: "Smith",
        company_domain: "acme.com",
      })
      expect(r.ok).toBe(true)
    })

    it("returns not_found when ZoomInfo returns no match", async () => {
      bridge.whenPost("/enrich/contact").respond(200, { data: { result: [{ data: [] }] } })
      const r = await enrichContactImpl({ contact_id: "missing" })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe("not_found")
    })
  })

  describe("search_companies", () => {
    it("builds the body and normalizes results", async () => {
      bridge.whenPost("/search/company").respond(200, {
        totalResults: 1,
        data: [
          { id: "c_1", name: "Acme", website: "acme.com", employeeCount: 250, revenue: 50000000 },
        ],
      })
      const r = await searchCompaniesImpl({
        industries: ["Computer Software"],
        technologies: ["Snowflake"],
      })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.data.companies).toHaveLength(1)
        expect(r.data.companies[0].domain).toBe("acme.com")
        expect(r.data.companies[0].employee_count).toBe(250)
      }
    })
  })

  describe("enrich_company", () => {
    it("returns validation_failed without input", async () => {
      const r = await enrichCompanyImpl({})
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe("validation_failed")
    })

    it("normalizes techAttributes + departmentBudgets + recentNews", async () => {
      bridge.whenPost("/enrich/company").respond(200, {
        data: {
          result: [
            {
              data: [
                {
                  id: "c_1",
                  name: "Acme",
                  website: "acme.com",
                  employeeCount: 500,
                  techAttributes: [
                    { name: "Snowflake" },
                    { name: "React" },
                    "AWS",
                  ],
                  departmentBudgets: [
                    { department: "Engineering", employeeCount: 120 },
                    { department: "Sales", employeeCount: 80 },
                  ],
                  recentNews: [
                    { title: "Acme raises Series C" },
                    "Acme launches new product",
                  ],
                  socialMediaUrls: [{ type: "linkedin", url: "https://linkedin.com/company/acme" }],
                },
              ],
            },
          ],
        },
      })
      const r = await enrichCompanyImpl({ company_domain: "acme.com" })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.data.company.technologies).toEqual(["Snowflake", "React", "AWS"])
        expect(r.data.company.employee_count_by_department).toMatchObject({
          Engineering: 120,
          Sales: 80,
        })
        expect(r.data.company.recent_news).toHaveLength(2)
        expect(r.data.company.linkedin_url).toContain("acme")
      }
    })
  })

  describe("get_intent", () => {
    it("validates that company_id or company_domain is provided", async () => {
      const r = await getIntentImpl({})
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe("validation_failed")
    })

    it("normalizes intent topics with score+trending_since", async () => {
      bridge.whenPost("/enrich/intent").respond(200, {
        data: {
          result: [
            {
              data: [
                {
                  companyId: 123,
                  intent: [
                    { topic: "CRM", signalScore: 85, lastTrendingDate: "2026-04-01" },
                    { topic: "Marketing Automation", signalScore: 60, lastTrendingDate: null },
                  ],
                },
              ],
            },
          ],
        },
      })
      const r = await getIntentImpl({ company_id: "123" })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.data.intent_topics).toHaveLength(2)
        expect(r.data.intent_topics[0]).toMatchObject({
          topic: "CRM",
          score: 85,
          trending_since: "2026-04-01",
        })
      }
    })
  })

  describe("get_org_chart", () => {
    it("validates that company_id or company_domain is provided", async () => {
      const r = await getOrgChartImpl({})
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe("validation_failed")
    })

    it("issues a search/contact filtered by managementLevel", async () => {
      bridge.whenPost("/search/contact").respond(200, {
        totalResults: 1,
        data: [{ id: "p_1", firstName: "Cassandra", lastName: "Chu", jobTitle: "CTO", managementLevel: "C-Level" }],
      })
      const r = await getOrgChartImpl({ company_id: "c_1" })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.data.executives).toHaveLength(1)
        expect(r.data.executives[0].job_title).toBe("CTO")
      }
      const call = bridge.calls.find((c) => c.endpoint === "/search/contact")
      expect(call!.body).toMatchObject({
        companyId: "c_1",
        managementLevel: "C-Level,VP-Level",
      })
    })
  })
})
