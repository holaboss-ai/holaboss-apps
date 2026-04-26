import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { setBridgeClient } from "../../src/server/instantly-client"
import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import {
  removeLeadFromCampaignImpl,
  sendTestEmailImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("instantly_send_test_email", () => {
  let tmp: string
  let bridge: MockBridge

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "instantly-test-"))
    resetDbForTests(path.join(tmp, "instantly.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("rejects malformed to_email as validation_failed", async () => {
    const result = await sendTestEmailImpl({
      campaign_id: "cmp_1",
      step_index: 1,
      to_email: "not-an-email",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("validation_failed")
  })

  it("rejects step_index < 1 as validation_failed", async () => {
    const result = await sendTestEmailImpl({
      campaign_id: "cmp_1",
      step_index: 0,
      to_email: "qa@example.com",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("validation_failed")
  })

  it("returns sent=true on 200 from /test-send", async () => {
    bridge.whenPost("/api/v2/campaigns/cmp_1/test-send").respond(200, { ok: true })
    const result = await sendTestEmailImpl({
      campaign_id: "cmp_1",
      step_index: 2,
      to_email: "qa@example.com",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.sent).toBe(true)
      expect(result.data.step_index).toBe(2)
      expect(result.data.to_email).toBe("qa@example.com")
    }
  })

  it("propagates 404 from upstream as not_found", async () => {
    bridge.whenPost("/api/v2/campaigns/cmp_x/test-send").respond(404, { message: "step missing" })
    const result = await sendTestEmailImpl({
      campaign_id: "cmp_x",
      step_index: 9,
      to_email: "qa@example.com",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("not_found")
  })
})

describe("instantly_remove_lead_from_campaign idempotency", () => {
  let tmp: string
  let bridge: MockBridge

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "instantly-rm-"))
    resetDbForTests(path.join(tmp, "instantly.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns removed=true on 200", async () => {
    bridge.whenAny().respond(200, { ok: true })
    const r = await removeLeadFromCampaignImpl({ campaign_id: "cmp_1", lead_id: "lead_1" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.removed).toBe(true)
  })

  it("returns removed=false (not error) when upstream returns 404", async () => {
    bridge.whenAny().respond(404, { message: "lead not in campaign" })
    const r = await removeLeadFromCampaignImpl({ campaign_id: "cmp_1", lead_id: "missing" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.removed).toBe(false)
  })
})
