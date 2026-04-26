import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { setBridgeClient } from "../../src/server/instantly-client"
import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { addLeadToCampaignImpl } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("instantly_add_lead_to_campaign", () => {
  let tmp: string
  let bridge: MockBridge

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "instantly-addlead-"))
    resetDbForTests(path.join(tmp, "instantly.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns added_count + skipped_count from API response", async () => {
    bridge.whenPost("/api/v2/leads/list").respond(200, {
      items: [
        { id: "lead_1" },
        { id: "lead_2" },
      ],
      added: 2,
      skipped: 1,
    })

    const result = await addLeadToCampaignImpl({
      campaign_id: "cmp_1",
      leads: [
        { email: "a@b.com" },
        { email: "c@d.com" },
        { email: "duplicate@b.com" },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.added_count).toBe(2)
      expect(result.data.skipped_count).toBe(1)
      expect(result.data.lead_ids).toEqual(["lead_1", "lead_2"])
    }
  })

  it("rejects empty leads array as validation_failed", async () => {
    const result = await addLeadToCampaignImpl({
      campaign_id: "cmp_1",
      leads: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("validation_failed")
  })

  it("rejects more than 100 leads as validation_failed", async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ email: `u${i}@x.com` }))
    const result = await addLeadToCampaignImpl({
      campaign_id: "cmp_1",
      leads: tooMany,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("validation_failed")
  })

  it("falls back to lead_ids length when API omits added/skipped counts", async () => {
    bridge.whenPost("/api/v2/leads/list").respond(200, {
      items: [{ id: "lead_x" }],
    })

    const result = await addLeadToCampaignImpl({
      campaign_id: "cmp_1",
      leads: [{ email: "x@y.com" }, { email: "y@z.com" }],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.added_count).toBe(1)
      expect(result.data.skipped_count).toBe(1)
    }
  })

  it("propagates upstream 422 as validation_failed", async () => {
    bridge.whenPost("/api/v2/leads/list").respond(422, {
      message: "campaign is completed",
    })

    const result = await addLeadToCampaignImpl({
      campaign_id: "cmp_done",
      leads: [{ email: "a@b.com" }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("validation_failed")
      expect(result.error.message).toContain("completed")
    }
  })
})
