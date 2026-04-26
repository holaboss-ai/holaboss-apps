/**
 * Live tests against real Composio.
 *
 * Skipped by default. To run:
 *   1. Start the broker:    COMPOSIO_API_KEY=xxx pnpm composio:broker
 *   2. Connect Apollo:       COMPOSIO_API_KEY=xxx pnpm composio:connect apollo --api-key apollo_xxx
 *   3. Run from this module: pnpm test:live
 *
 * See ../docs/LIVE_TESTING.md for the full setup.
 *
 * Read-only by default. Set LIVE_WRITE=1 to also exercise write tools.
 *
 * NOTE on Apollo plan tiers: Apollo's REST surface is heavily gated by plan.
 * Free / starter keys hit "is not accessible with this api_key" on
 * /mixed_people/search, /mixed_companies/search, /emailer_campaigns/search,
 * and /emailer_messages/search. Sequence write endpoints additionally require
 * a master API key. We treat those failures as ENVIRONMENTAL (plan gate, not
 * a bug) and let the test pass with a console note — that way CI on a free
 * key still goes green.
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

/**
 * Returns true if the result is ok and assertions should run.
 * Returns false if the result is a known environmental gate (free plan,
 * master-key required) — the caller should silently skip downstream
 * assertions. Throws (via expect) on any unexpected failure.
 */
function okOrPlanGated(
  r: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } },
  label: string,
): boolean {
  if (r.ok) return true
  const msg = r.error.message
  // Apollo's plan-tier rejection message family.
  if (/not accessible with this api_key|free plan|requires.*plan|upgrade.*plan|requires master/i.test(msg)) {
    console.log(`[live] ${label}: SKIPPED — Apollo plan limit: ${msg}`)
    return false
  }
  // Anything else (rate_limited, real not_connected, validation_failed, etc.) → genuine fail.
  expect(r.ok, `${label} unexpectedly failed: ${r.error.code} — ${msg}`).toBe(true)
  return false
}

describe.skipIf(!live)("apollo live (real Composio)", () => {
  beforeAll(() => resetBridgeClient())
  afterAll(() => resetBridgeClient())

  describe("read-only", () => {
    it("apollo_get_connection_status returns connected:true", async () => {
      const r = await getConnectionStatusImpl({})
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.connected).toBe(true)
    }, 30_000)

    it("apollo_search_people returns an array of people", async () => {
      const r = await searchPeopleImpl({ person_titles: ["VP Engineering"], per_page: 5 })
      if (!okOrPlanGated(r, "apollo_search_people")) return
      if (r.ok) expect(Array.isArray(r.data.people)).toBe(true)
    }, 30_000)

    it("apollo_search_organizations returns an array of orgs", async () => {
      const r = await searchOrganizationsImpl({ q_keywords: "saas", per_page: 5 })
      if (!okOrPlanGated(r, "apollo_search_organizations")) return
      if (r.ok) expect(Array.isArray(r.data.organizations)).toBe(true)
    }, 30_000)

    it("apollo_list_sequences returns an array (master key required on most plans)", async () => {
      const r = await listSequencesImpl({})
      if (!okOrPlanGated(r, "apollo_list_sequences")) return
      if (r.ok) expect(Array.isArray(r.data.sequences)).toBe(true)
    }, 30_000)

    it("apollo_list_emails_sent requires sequence_id or contact_id (skipped if no sequences are accessible)", async () => {
      // First find an accessible sequence to scope the query — without scope,
      // /emailer_messages/search returns validation_failed by design.
      const seqs = await listSequencesImpl({})
      if (!okOrPlanGated(seqs, "apollo_list_sequences (prereq)")) return
      if (!seqs.ok || seqs.data.sequences.length === 0) {
        console.log(`[live] apollo_list_emails_sent: SKIPPED — no sequences in workspace`)
        return
      }
      const sequence_id = seqs.data.sequences[0].id
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const r = await listEmailsSentImpl({ sequence_id, since, limit: 5 })
      if (!okOrPlanGated(r, "apollo_list_emails_sent")) return
      if (r.ok) expect(Array.isArray(r.data.emails)).toBe(true)
    }, 30_000)
  })

  describe.skipIf(!liveWrite)("write (LIVE_WRITE=1 — consumes Apollo credits)", () => {
    it("apollo_enrich_person — match / no_match / rate_limited are all acceptable", async () => {
      const r = await enrichPersonImpl({
        first_name: "Test",
        last_name: "User",
        organization_domain: "example.com",
      })
      if (!r.ok) {
        // Plan gate, credit cap, or no-match — all acceptable here.
        expect(["validation_failed", "rate_limited", "not_connected", "not_found"]).toContain(
          r.error.code,
        )
      }
    }, 30_000)
  })
})
