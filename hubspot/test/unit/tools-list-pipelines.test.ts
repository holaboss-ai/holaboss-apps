import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/hubspot-client"
import { listPipelinesImpl } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("listPipelinesImpl", () => {
  let bridge: MockBridge
  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("normalizes pipelines + stages and unwraps probability from metadata", async () => {
    bridge.whenGet("/crm/v3/pipelines/deals").respond(200, {
      results: [
        {
          id: "default",
          label: "Sales Pipeline",
          stages: [
            {
              id: "appointmentscheduled",
              label: "Appointment Scheduled",
              displayOrder: 0,
              metadata: { probability: "0.2" },
            },
            {
              id: "closedwon",
              label: "Closed Won",
              displayOrder: 5,
              metadata: { probability: "1.0" },
            },
            { id: "closedlost", label: "Closed Lost", displayOrder: 6, metadata: {} },
          ],
        },
      ],
    })

    const r = await listPipelinesImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.pipelines).toHaveLength(1)
      const p = r.data.pipelines[0]
      expect(p.pipeline_id).toBe("default")
      expect(p.label).toBe("Sales Pipeline")
      expect(p.stages).toHaveLength(3)
      expect(p.stages[0]).toEqual({
        stage_id: "appointmentscheduled",
        label: "Appointment Scheduled",
        display_order: 0,
        probability: 0.2,
      })
      expect(p.stages[2].probability).toBeNull()
    }
  })
})
