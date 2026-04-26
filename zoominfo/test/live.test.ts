/**
 * Live tests against real Composio. See ../docs/LIVE_TESTING.md.
 * Run: pnpm test:live (after pnpm composio:broker + pnpm composio:connect zoominfo).
 *
 * Read-only by default. ZoomInfo's API is entirely read-only so LIVE_WRITE
 * does nothing here — every tool is safe to run against a real workspace.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  enrichCompanyImpl,
  enrichContactImpl,
  getConnectionStatusImpl,
  searchCompaniesImpl,
  searchContactsImpl,
} from "../src/server/tools"
import { resetBridgeClient } from "../src/server/zoominfo-client"

const live = !!process.env.LIVE

describe.skipIf(!live)("zoominfo live (real Composio)", () => {
  beforeAll(() => resetBridgeClient())
  afterAll(() => resetBridgeClient())

  it("zoominfo_get_connection_status returns connected:true", async () => {
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.connected).toBe(true)
  }, 30_000)

  it("zoominfo_search_contacts returns an array", async () => {
    const r = await searchContactsImpl({ job_titles: ["CMO"], page_size: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.contacts)).toBe(true)
  }, 30_000)

  it("zoominfo_search_companies returns an array", async () => {
    const r = await searchCompaniesImpl({ industries: ["Computer Software"], page_size: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.companies)).toBe(true)
  }, 30_000)

  // Enrichment consumes credits — gate behind LIVE_WRITE so a casual
  // `pnpm test:live` run doesn't drain the user's credit balance.
  describe.skipIf(!process.env.LIVE_WRITE)("credit-bearing (LIVE_WRITE=1)", () => {
    it("zoominfo_enrich_contact accepts (first_name + last_name + company_domain)", async () => {
      const r = await enrichContactImpl({
        first_name: "Satya",
        last_name: "Nadella",
        company_domain: "microsoft.com",
      })
      // Match → ok; unknown → not_found; cap hit → rate_limited.
      if (!r.ok) {
        expect(["not_found", "rate_limited"]).toContain(r.error.code)
      }
    }, 30_000)

    it("zoominfo_enrich_company accepts company_domain", async () => {
      const r = await enrichCompanyImpl({ company_domain: "microsoft.com" })
      if (!r.ok) {
        expect(["not_found", "rate_limited"]).toContain(r.error.code)
      }
    }, 30_000)
  })
})
