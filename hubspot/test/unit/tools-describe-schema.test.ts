import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/hubspot-client"
import { describeSchemaImpl } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("describeSchemaImpl", () => {
  let bridge: MockBridge
  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("hits the v3 properties endpoint for the given object_type", async () => {
    bridge.whenGet("/crm/v3/properties/contacts").respond(200, { results: [] })
    const r = await describeSchemaImpl({ object_type: "contacts" })
    expect(r.ok).toBe(true)
    expect(bridge.calls[0].endpoint).toContain("/crm/v3/properties/contacts")
  })

  it("normalizes properties: name, label, type, fieldType, calculated→is_calculated", async () => {
    bridge.whenGet("/crm/v3/properties/contacts").respond(200, {
      results: [
        {
          name: "email",
          label: "Email",
          type: "string",
          fieldType: "text",
          calculated: false,
        },
        {
          name: "score",
          label: "Score",
          type: "number",
          fieldType: "calculation_score",
          calculated: true,
        },
      ],
    })
    const r = await describeSchemaImpl({ object_type: "contacts" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.object_type).toBe("contacts")
      expect(r.data.properties).toHaveLength(2)
      expect(r.data.properties[0]).toEqual({
        name: "email",
        label: "Email",
        type: "string",
        fieldType: "text",
        is_required: false,
        is_calculated: false,
      })
      expect(r.data.properties[1].is_calculated).toBe(true)
    }
  })

  it("unwraps options[] for enumeration properties", async () => {
    bridge.whenGet("/crm/v3/properties/contacts").respond(200, {
      results: [
        {
          name: "lifecyclestage",
          label: "Lifecycle Stage",
          type: "enumeration",
          fieldType: "select",
          options: [
            { label: "Lead", value: "lead" },
            { label: "Opportunity", value: "opportunity" },
          ],
        },
      ],
    })
    const r = await describeSchemaImpl({ object_type: "contacts" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const lifecycle = r.data.properties[0]
      expect(lifecycle.options).toEqual([
        { label: "Lead", value: "lead" },
        { label: "Opportunity", value: "opportunity" },
      ])
    }
  })

  it("omits options when the property has none", async () => {
    bridge.whenGet("/crm/v3/properties/contacts").respond(200, {
      results: [{ name: "email", label: "Email", type: "string", fieldType: "text" }],
    })
    const r = await describeSchemaImpl({ object_type: "contacts" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.properties[0].options).toBeUndefined()
  })
})
