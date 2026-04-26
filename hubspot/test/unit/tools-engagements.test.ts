import { beforeEach, describe, expect, it } from "vitest"

import { setBridgeClient } from "../../src/server/hubspot-client"
import {
  addNoteImpl,
  createTaskImpl,
  resetPortalIdCacheForTests,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("addNoteImpl", () => {
  let bridge: MockBridge
  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
    resetPortalIdCacheForTests()
  })

  it("POSTs note with hs_note_body, hs_timestamp, and HUBSPOT_DEFINED association to contact (typeId 202)", async () => {
    bridge.whenPost("/crm/v3/objects/notes").respond(201, { id: "note_1" })
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 7 })

    const r = await addNoteImpl({
      parent_object: "contacts",
      parent_record_id: "101",
      content: "spoke with Alice",
      timestamp: "2026-04-26T10:00:00Z",
    })
    expect(r.ok).toBe(true)

    const post = bridge.calls.find((c) => c.method === "POST")!
    const body = post.body as {
      properties: Record<string, unknown>
      associations: Array<{ to: { id: string }; types: Array<Record<string, unknown>> }>
    }
    expect(body.properties.hs_note_body).toBe("spoke with Alice")
    expect(body.properties.hs_timestamp).toBe("2026-04-26T10:00:00Z")
    expect(body.associations).toHaveLength(1)
    expect(body.associations[0].to).toEqual({ id: "101" })
    expect(body.associations[0].types[0]).toEqual({
      associationCategory: "HUBSPOT_DEFINED",
      associationTypeId: 202, // note → contact
    })

    if (r.ok) {
      expect(r.data.note_id).toBe("note_1")
      expect(r.data.hubspot_deep_link).toBe("https://app.hubspot.com/contacts/7/contact/101")
    }
  })

  it("uses associationTypeId 190 for note→company and 214 for note→deal", async () => {
    bridge.whenPost("/crm/v3/objects/notes").respond(201, { id: "n_x" })
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 7 })

    await addNoteImpl({
      parent_object: "companies",
      parent_record_id: "200",
      content: "x",
    })
    const company = bridge.calls.find(
      (c) => c.method === "POST" && c.endpoint.endsWith("/crm/v3/objects/notes"),
    )!
    expect(
      ((company.body as Record<string, unknown>).associations as Array<{
        types: Array<{ associationTypeId: number }>
      }>)[0].types[0].associationTypeId,
    ).toBe(190)

    bridge.reset()
    bridge.whenPost("/crm/v3/objects/notes").respond(201, { id: "n_y" })
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 7 })
    await addNoteImpl({ parent_object: "deals", parent_record_id: "300", content: "x" })
    const deal = bridge.calls.find((c) => c.method === "POST")!
    expect(
      ((deal.body as Record<string, unknown>).associations as Array<{
        types: Array<{ associationTypeId: number }>
      }>)[0].types[0].associationTypeId,
    ).toBe(214)
  })

  it("defaults timestamp to ISO 'now' when not provided", async () => {
    bridge.whenPost("/crm/v3/objects/notes").respond(201, { id: "n_z" })
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 7 })
    await addNoteImpl({
      parent_object: "contacts",
      parent_record_id: "1",
      content: "hi",
    })
    const body = bridge.calls.find((c) => c.method === "POST")!.body as {
      properties: { hs_timestamp: string }
    }
    expect(body.properties.hs_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe("createTaskImpl", () => {
  let bridge: MockBridge
  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
    resetPortalIdCacheForTests()
  })

  it("supports multi-link associations using HUBSPOT_DEFINED type ids", async () => {
    bridge.whenPost("/crm/v3/objects/tasks").respond(201, { id: "task_1" })

    const r = await createTaskImpl({
      subject: "Send proposal",
      body: "Detailed Q2 proposal",
      due_date: "2026-04-30T17:00:00Z",
      priority: "HIGH",
      assignee_owner_id: "5555",
      linked_records: [
        { object_type: "contacts", record_id: "101" },
        { object_type: "deals", record_id: "777" },
      ],
    })
    expect(r.ok).toBe(true)

    const post = bridge.calls[0]
    const body = post.body as {
      properties: Record<string, unknown>
      associations: Array<{ to: { id: string }; types: Array<{ associationTypeId: number }> }>
    }
    expect(body.properties.hs_task_subject).toBe("Send proposal")
    expect(body.properties.hs_task_body).toBe("Detailed Q2 proposal")
    expect(body.properties.hs_task_priority).toBe("HIGH")
    expect(body.properties.hubspot_owner_id).toBe("5555")
    expect(body.properties.hs_timestamp).toBe("2026-04-30T17:00:00Z")
    expect(body.properties.hs_task_status).toBe("NOT_STARTED")
    expect(body.properties.hs_task_type).toBe("TODO")

    expect(body.associations).toHaveLength(2)
    expect(body.associations[0].types[0].associationTypeId).toBe(204) // task → contact
    expect(body.associations[1].types[0].associationTypeId).toBe(216) // task → deal
  })

  it("omits associations key entirely when no linked_records given", async () => {
    bridge.whenPost("/crm/v3/objects/tasks").respond(201, { id: "task_x" })
    await createTaskImpl({ subject: "Lone wolf task" })
    const body = bridge.calls[0].body as Record<string, unknown>
    expect(body.associations).toBeUndefined()
  })
})
