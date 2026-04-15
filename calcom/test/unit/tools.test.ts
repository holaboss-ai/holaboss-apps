import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { setBridgeClient } from "../../src/server/calcom-client"
import {
  getConnectionStatusImpl,
  listEventTypesImpl,
  getEventTypeImpl,
  listBookingsImpl,
  getBookingImpl,
  cancelBookingImpl,
  rescheduleBookingImpl,
  listAvailableSlotsImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("calcom tools", () => {
  let bridge: MockBridge
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "calcom-tools-"))
    resetDbForTests(path.join(tmp, "calcom.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("get_connection_status returns connected true when event-types probe returns 200", async () => {
    bridge.whenGet("/v2/event-types").respond(200, { status: "success", data: [{ id: 1 }, { id: 2 }] })
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.connected).toBe(true)
      expect(r.data.event_types_count).toBe(2)
    }
  })

  it("get_connection_status returns connected false on not_connected", async () => {
    bridge.whenGet("/v2/event-types").throwOnce(new Error("No cal integration configured"))
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.connected).toBe(false)
  })

  it("list_event_types returns mapped summaries", async () => {
    bridge.whenGet("/v2/event-types").respond(200, {
      status: "success",
      data: [
        {
          id: 101,
          slug: "30min",
          title: "30-min intro",
          lengthInMinutes: 30,
          description: "Quick intro call",
          schedulingUrl: "https://cal.com/josh/30min",
          locations: [{ type: "integrations:google:meet" }],
        },
      ],
    })
    const r = await listEventTypesImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.event_types).toHaveLength(1)
      expect(r.data.event_types[0]).toMatchObject({
        id: "101",
        slug: "30min",
        title: "30-min intro",
        length_minutes: 30,
        booking_url: "https://cal.com/josh/30min",
      })
    }
  })

  it("get_event_type fetches by id", async () => {
    bridge.whenGet("/v2/event-types/101").respond(200, {
      status: "success",
      data: { id: 101, slug: "30min", title: "30-min intro", lengthInMinutes: 30, schedulingUrl: "https://cal.com/josh/30min" },
    })
    const r = await getEventTypeImpl({ event_type_id: "101" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.event_type.id).toBe("101")
  })

  it("list_bookings maps response and passes filter params", async () => {
    bridge.whenGet("/v2/bookings").respond(200, {
      status: "success",
      data: [
        {
          id: "bk_1",
          title: "30-min intro between Josh and Alice",
          start: "2026-04-20T10:00:00Z",
          end: "2026-04-20T10:30:00Z",
          status: "ACCEPTED",
          eventTypeId: 101,
          attendees: [{ name: "Alice", email: "alice@example.com", timeZone: "America/New_York" }],
          location: "https://meet.google.com/abc-defg-hij",
          meetingUrl: "https://meet.google.com/abc-defg-hij",
        },
      ],
    })
    const r = await listBookingsImpl({ status: "upcoming", limit: 20 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.bookings).toHaveLength(1)
      expect(r.data.bookings[0]).toMatchObject({
        id: "bk_1",
        start_time: "2026-04-20T10:00:00Z",
        attendees: [{ name: "Alice", email: "alice@example.com" }],
      })
    }
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.endpoint).toContain("status=upcoming")
  })

  it("get_booking fetches by id", async () => {
    bridge.whenGet("/v2/bookings/bk_1").respond(200, {
      status: "success",
      data: {
        id: "bk_1",
        title: "Intro",
        start: "2026-04-20T10:00:00Z",
        end: "2026-04-20T10:30:00Z",
        status: "ACCEPTED",
        attendees: [{ name: "Alice", email: "a@b.com" }],
      },
    })
    const r = await getBookingImpl({ booking_id: "bk_1" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.booking.id).toBe("bk_1")
  })

  it("cancel_booking posts to cancel endpoint with reason", async () => {
    bridge.whenPost("/v2/bookings/bk_1/cancel").respond(200, { status: "success", data: { id: "bk_1" } })
    const r = await cancelBookingImpl({ booking_id: "bk_1", reason: "Prospect rescheduling" })
    expect(r.ok).toBe(true)
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.method).toBe("POST")
    expect(lastCall.body).toEqual({ cancellationReason: "Prospect rescheduling" })
  })

  it("reschedule_booking posts to reschedule endpoint", async () => {
    bridge.whenPost("/v2/bookings/bk_1/reschedule").respond(200, {
      status: "success",
      data: { id: "bk_1_new" },
    })
    const r = await rescheduleBookingImpl({
      booking_id: "bk_1",
      new_start_time: "2026-04-21T14:00:00Z",
      reason: "Prospect asked",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.new_booking_id).toBe("bk_1_new")
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.body).toEqual({
      start: "2026-04-21T14:00:00Z",
      reschedulingReason: "Prospect asked",
    })
  })

  it("list_available_slots queries slots endpoint", async () => {
    bridge.whenGet("/v2/slots").respond(200, {
      status: "success",
      data: {
        "2026-04-20": [
          { start: "2026-04-20T10:00:00Z", end: "2026-04-20T10:30:00Z" },
          { start: "2026-04-20T11:00:00Z", end: "2026-04-20T11:30:00Z" },
        ],
      },
    })
    const r = await listAvailableSlotsImpl({
      event_type_id: "101",
      start_date: "2026-04-20",
      end_date: "2026-04-20",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.slots).toHaveLength(2)
  })
})