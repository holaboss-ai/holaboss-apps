/**
 * Live tests against real Composio.
 *
 * Skipped by default. To run:
 *   1. Start the broker:    COMPOSIO_API_KEY=xxx pnpm composio:broker
 *   2. Connect Apollo:       COMPOSIO_API_KEY=xxx pnpm composio:connect apollo
 *   3. Run from this module: pnpm test:live
 *
 * See ../docs/LIVE_TESTING.md for the full setup.
 *
 * Read-only by default. Set LIVE_WRITE=1 to also exercise write tools
 * (sequence add/remove). DO NOT set LIVE_WRITE=1 against an Apollo workspace
 * you care about — it will modify real cadences.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  enrichPersonImpl,
  getConnectionStatusImpl,
  listEmailsSentImpl,
  listSequencesImpl,
  searchOrganizationsImpl,
  searchPeopleImpl,
} from "../src/server/tools"
import { resetBridgeClient } from "../src/server/apollo-client"

const live = !!process.env.LIVE
const liveWrite = !!process.env.LIVE_WRITE

describe.skipIf(!live)("apollo live (real Composio)", () => {
  beforeAll(() => {
    // Force the SDK-backed default client (in case a unit test set a mock).
    resetBridgeClient()
  })

  afterAll(() => {
    resetBridgeClient()
  })

  describe("read-only", () => {
    it("apollo_get_connection_status returns connected:true", async () => {
      const r = await getConnectionStatusImpl({})
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.connected).toBe(true)
    }, 30_000)

    it("apollo_search_people returns an array of people", async () => {
      const r = await searchPeopleImpl({ person_titles: ["VP Engineering"], per_page: 5 })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(Array.isArray(r.data.people)).toBe(true)
      }
    }, 30_000)

    it("apollo_search_organizations returns an array of orgs", async () => {
      const r = await searchOrganizationsImpl({ q_keywords: "saas", per_page: 5 })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(Array.isArray(r.data.organizations)).toBe(true)
      }
    }, 30_000)

    it("apollo_list_sequences returns an array (may be empty for fresh workspaces)", async () => {
      const r = await listSequencesImpl({})
      // Non-master keys 403 → not_connected; allow that as a known limitation
      // rather than a hard failure of this live run.
      if (!r.ok && r.error.code === "not_connected") {
        return
      }
      expect(r.ok).toBe(true)
      if (r.ok) expect(Array.isArray(r.data.sequences)).toBe(true)
    }, 30_000)

    it("apollo_list_emails_sent accepts a date filter and returns an array", async () => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const r = await listEmailsSentImpl({ since, limit: 5 })
      if (!r.ok && r.error.code === "not_connected") return
      expect(r.ok).toBe(true)
      if (r.ok) expect(Array.isArray(r.data.emails)).toBe(true)
    }, 30_000)
  })

  describe.skipIf(!liveWrite)("write (LIVE_WRITE=1)", () => {
    it("apollo_enrich_person consumes a credit (skipped without explicit opt-in)", async () => {
      // Even with LIVE_WRITE this is just a credit-cost read; no record is
      // mutated upstream. Kept under the write block because credits are
      // billable.
      const r = await enrichPersonImpl({
        first_name: "Test",
        last_name: "User",
        organization_domain: "example.com",
      })
      // Either we matched (200), didn't match (validation_failed), or hit the
      // credit cap (rate_limited). All three are acceptable outcomes.
      expect(["validation_failed", "rate_limited", undefined]).toContain(
        r.ok ? undefined : r.error.code,
      )
    }, 30_000)
  })
})
