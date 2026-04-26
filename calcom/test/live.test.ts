/**
 * Live tests against real Composio. See ../docs/LIVE_TESTING.md.
 * Run: pnpm test:live (after pnpm composio:broker + pnpm composio:connect calcom).
 *
 * Read-only — write tools (cancel/reschedule) deliberately NOT wired into
 * LIVE_WRITE because they email the attendee. Test those manually if needed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  getConnectionStatusImpl,
  listAvailableSlotsImpl,
  listBookingsImpl,
  listEventTypesImpl,
} from "../src/server/tools"
import { resetBridgeClient } from "../src/server/calcom-client"

const live = !!process.env.LIVE

describe.skipIf(!live)("calcom live (real Composio)", () => {
  beforeAll(() => resetBridgeClient())
  afterAll(() => resetBridgeClient())

  it("calcom_get_connection_status returns connected:true", async () => {
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.connected).toBe(true)
  }, 30_000)

  it("calcom_list_event_types returns an array", async () => {
    const r = await listEventTypesImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.event_types)).toBe(true)
  }, 30_000)

  it("calcom_list_bookings(status:'upcoming') returns an array", async () => {
    const r = await listBookingsImpl({ status: "upcoming", limit: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.bookings)).toBe(true)
  }, 30_000)

  it("calcom_list_available_slots returns an array (best-effort — needs at least one event type)", async () => {
    const events = await listEventTypesImpl({})
    if (!events.ok || events.data.event_types.length === 0) return
    const event_type_id = events.data.event_types[0].id
    const start = new Date().toISOString().slice(0, 10)
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const slots = await listAvailableSlotsImpl({ event_type_id, start_date: start, end_date: end })
    expect(slots.ok).toBe(true)
    if (slots.ok) expect(Array.isArray(slots.data.slots)).toBe(true)
  }, 30_000)
})
