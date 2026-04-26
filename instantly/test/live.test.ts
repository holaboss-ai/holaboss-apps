/**
 * Live tests against real Composio. See ../docs/LIVE_TESTING.md.
 * Run: pnpm test:live (after pnpm composio:broker + pnpm composio:connect instantly).
 *
 * Read-only by default. LIVE_WRITE=1 enables campaign create / pause / resume
 * tests. DO NOT set LIVE_WRITE against a production Instantly workspace —
 * pause/resume affects real running campaigns.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  getCampaignStatsImpl,
  getCampaignImpl,
  getConnectionStatusImpl,
  listCampaignsImpl,
  listLeadsImpl,
} from "../src/server/tools"
import { resetBridgeClient } from "../src/server/instantly-client"

const live = !!process.env.LIVE

describe.skipIf(!live)("instantly live (real Composio)", () => {
  beforeAll(() => resetBridgeClient())
  afterAll(() => resetBridgeClient())

  it("instantly_get_connection_status returns connected:true", async () => {
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.connected).toBe(true)
  }, 30_000)

  it("instantly_list_campaigns returns an array", async () => {
    const r = await listCampaignsImpl({ limit: 10 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.campaigns)).toBe(true)
  }, 30_000)

  it("instantly_get_campaign + instantly_list_leads + instantly_get_campaign_stats round-trip on the first campaign (if any)", async () => {
    const list = await listCampaignsImpl({ limit: 1 })
    expect(list.ok).toBe(true)
    if (!list.ok || list.data.campaigns.length === 0) return // Empty workspace — that's fine.
    const campaign_id = list.data.campaigns[0].id

    const detail = await getCampaignImpl({ campaign_id })
    expect(detail.ok).toBe(true)

    const leads = await listLeadsImpl({ campaign_id, limit: 5 })
    expect(leads.ok).toBe(true)
    if (leads.ok) expect(Array.isArray(leads.data.leads)).toBe(true)

    const stats = await getCampaignStatsImpl({ campaign_id })
    expect(stats.ok).toBe(true)
    if (stats.ok) {
      expect(typeof stats.data.sent).toBe("number")
      expect(typeof stats.data.replied).toBe("number")
    }
  }, 60_000)
})
