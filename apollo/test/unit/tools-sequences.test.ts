import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/apollo-client"
import {
  addToSequenceImpl,
  listSequencesImpl,
  removeFromSequenceImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("apollo sequence tools", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("apollo_list_sequences hits POST /emailer_campaigns/search", async () => {
    bridge.whenPost("/emailer_campaigns/search").respond(200, {
      emailer_campaigns: [
        { id: "s_1", name: "Q2 Outbound", active: true, archived: false, num_steps: 4 },
      ],
    })
    const r = await listSequencesImpl({ q_name: "Q2" })
    expect(r.ok).toBe(true)
    const sentBody = bridge.calls[0].body as Record<string, unknown>
    expect(sentBody.q_name).toBe("Q2")
    if (r.ok) {
      expect(r.data.sequences[0].name).toBe("Q2 Outbound")
      expect(r.data.sequences[0].num_steps).toBe(4)
    }
  })

  it("apollo_add_to_sequence rejects empty contact_ids without hitting API", async () => {
    const r = await addToSequenceImpl({ sequence_id: "s_1", contact_ids: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("validation_failed")
    expect(bridge.calls).toHaveLength(0)
  })

  it("apollo_add_to_sequence reports added vs already_in_sequence (idempotent)", async () => {
    bridge.whenPost("/emailer_campaigns/s_1/add_contact_ids").respond(200, {
      num_added: 1,
      num_skipped: 1,
    })
    const r = await addToSequenceImpl({
      sequence_id: "s_1",
      contact_ids: ["c_1", "c_2"],
      send_email_from_email_account_id: "m_1",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.added).toBe(1)
      expect(r.data.already_in_sequence).toBe(1)
      expect(r.data.result_summary).toContain("already")
    }
  })

  it("apollo_remove_from_sequence hits remove_or_stop_contact_ids with default mode=remove", async () => {
    bridge
      .whenPost("/emailer_campaigns/remove_or_stop_contact_ids")
      .respond(200, { num_removed: 2 })
    const r = await removeFromSequenceImpl({
      sequence_id: "s_1",
      contact_ids: ["c_1", "c_2"],
    })
    expect(r.ok).toBe(true)
    const sentBody = bridge.calls[0].body as Record<string, unknown>
    expect(sentBody.mode).toBe("remove")
    expect(sentBody.emailer_campaign_ids).toEqual(["s_1"])
    if (r.ok) expect(r.data.removed).toBe(2)
  })

  it("apollo_remove_from_sequence is idempotent (removed=0 is success)", async () => {
    bridge
      .whenPost("/emailer_campaigns/remove_or_stop_contact_ids")
      .respond(200, { num_removed: 0 })
    const r = await removeFromSequenceImpl({ sequence_id: "s_1", contact_ids: ["c_1"] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.removed).toBe(0)
  })
})
