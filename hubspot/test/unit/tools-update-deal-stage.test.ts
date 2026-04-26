import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/hubspot-client"
import {
  resetPortalIdCacheForTests,
  updateDealStageImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("updateDealStageImpl", () => {
  let bridge: MockBridge
  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
    resetPortalIdCacheForTests()
  })

  it("PATCHes dealstage and returns deep link with portal id", async () => {
    bridge
      .whenPatch("/crm/v3/objects/deals/987")
      .respond(200, { id: "987", properties: { dealstage: "stage_proposal" } })
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 42 })

    const r = await updateDealStageImpl({ deal_id: "987", stage_id: "stage_proposal" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.deal_id).toBe("987")
      expect(r.data.dealstage).toBe("stage_proposal")
      expect(r.data.hubspot_deep_link).toBe("https://app.hubspot.com/contacts/42/deal/987")
    }

    // Verify the PATCH body shape
    const patchCall = bridge.calls.find((c) => c.method === "PATCH")
    expect(patchCall).toBeDefined()
    expect(patchCall!.body).toEqual({ properties: { dealstage: "stage_proposal" } })
  })

  it("propagates validation_failed when stage doesn't belong to pipeline", async () => {
    bridge.whenPatch("/crm/v3/objects/deals/987").respond(400, {
      message: "Property values were not valid: dealstage value 'foo' is not allowed in pipeline 'default'",
    })

    const r = await updateDealStageImpl({ deal_id: "987", stage_id: "foo" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("dealstage")
    }
  })

  it("propagates not_found for unknown deal id", async () => {
    bridge.whenPatch("/crm/v3/objects/deals/missing").respond(404, { message: "Not found" })
    const r = await updateDealStageImpl({ deal_id: "missing", stage_id: "stage_x" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_found")
  })
})
