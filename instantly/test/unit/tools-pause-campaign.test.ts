import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { setBridgeClient } from "../../src/server/instantly-client"
import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { pauseCampaignImpl, resumeCampaignImpl } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("instantly_pause_campaign / instantly_resume_campaign idempotency", () => {
  let tmp: string
  let bridge: MockBridge

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "instantly-pause-"))
    resetDbForTests(path.join(tmp, "instantly.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("pause on already-paused campaign is a no-op (no /pause API call)", async () => {
    bridge
      .whenGet("/api/v2/campaigns/cmp_1")
      .respond(200, { id: "cmp_1", status: "paused" })

    const result = await pauseCampaignImpl({ campaign_id: "cmp_1" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe("paused")
      expect(result.data.already_paused).toBe(true)
    }

    // Only the GET happened — no POST /pause.
    const postCalls = bridge.calls.filter((c) => c.method === "POST")
    expect(postCalls).toHaveLength(0)
  })

  it("pause on active campaign issues POST /pause", async () => {
    bridge
      .whenGet("/api/v2/campaigns/cmp_1")
      .respond(200, { id: "cmp_1", status: "active" })
    bridge.whenPost("/api/v2/campaigns/cmp_1/pause").respond(200, { ok: true })

    const result = await pauseCampaignImpl({ campaign_id: "cmp_1" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe("paused")
      expect(result.data.already_paused).toBe(false)
    }
  })

  it("pause on completed campaign returns invalid_state", async () => {
    bridge
      .whenGet("/api/v2/campaigns/cmp_1")
      .respond(200, { id: "cmp_1", status: "completed" })

    const result = await pauseCampaignImpl({ campaign_id: "cmp_1" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("invalid_state")
  })

  it("resume on already-active campaign is a no-op", async () => {
    bridge
      .whenGet("/api/v2/campaigns/cmp_1")
      .respond(200, { id: "cmp_1", status: "active" })

    const result = await resumeCampaignImpl({ campaign_id: "cmp_1" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe("active")
      expect(result.data.already_active).toBe(true)
    }

    const postCalls = bridge.calls.filter((c) => c.method === "POST")
    expect(postCalls).toHaveLength(0)
  })

  it("resume on paused campaign issues POST /activate", async () => {
    bridge
      .whenGet("/api/v2/campaigns/cmp_1")
      .respond(200, { id: "cmp_1", status: "paused" })
    bridge.whenPost("/api/v2/campaigns/cmp_1/activate").respond(200, { ok: true })

    const result = await resumeCampaignImpl({ campaign_id: "cmp_1" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe("active")
      expect(result.data.already_active).toBe(false)
    }
  })

  it("resume on completed campaign returns invalid_state", async () => {
    bridge
      .whenGet("/api/v2/campaigns/cmp_1")
      .respond(200, { id: "cmp_1", status: "completed" })

    const result = await resumeCampaignImpl({ campaign_id: "cmp_1" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("invalid_state")
  })
})
