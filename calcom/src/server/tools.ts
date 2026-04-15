import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { apiGet, apiPost } from "./calcom-client"
import { wrapTool } from "./audit"
import type {
  AvailabilitySlot,
  BookingAttendee,
  BookingSummary,
  CalcomError,
  EventTypeSummary,
  Result,
  ToolSuccessMeta,
} from "../lib/types"

const CALCOM_APP_BASE = "https://app.cal.com"

function bookingDeepLink(id: string) {
  return `${CALCOM_APP_BASE}/bookings/${id}`
}
function eventTypeDeepLink(id: string) {
  return `${CALCOM_APP_BASE}/event-types/${id}`
}

function mapEventType(raw: Record<string, unknown>): EventTypeSummary {
  const locations = Array.isArray(raw.locations) ? (raw.locations as Array<Record<string, unknown>>) : []
  return {
    id: String(raw.id ?? ""),
    slug: String(raw.slug ?? ""),
    title: String(raw.title ?? ""),
    length_minutes: Number(raw.lengthInMinutes ?? raw.length ?? 0),
    description: (raw.description as string | null) ?? null,
    booking_url: String(raw.schedulingUrl ?? raw.link ?? ""),
    location_type: locations[0] ? String(locations[0].type ?? "") : null,
  }
}

function mapAttendee(raw: Record<string, unknown>): BookingAttendee {
  return {
    name: String(raw.name ?? ""),
    email: String(raw.email ?? ""),
    timezone: raw.timeZone ? String(raw.timeZone) : undefined,
  }
}

function mapBooking(raw: Record<string, unknown>): BookingSummary {
  const attendees = Array.isArray(raw.attendees)
    ? (raw.attendees as Array<Record<string, unknown>>).map(mapAttendee)
    : []
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    start_time: String(raw.start ?? raw.startTime ?? ""),
    end_time: String(raw.end ?? raw.endTime ?? ""),
    status: String(raw.status ?? ""),
    event_type_id: raw.eventTypeId != null ? String(raw.eventTypeId) : null,
    attendees,
    location: (raw.location as string | null) ?? null,
    meeting_url: (raw.meetingUrl as string | null) ?? null,
  }
}

// -------------------- Connection --------------------

export async function getConnectionStatusImpl(
  _input: Record<string, never>,
): Promise<Result<{ connected: boolean; event_types_count?: number } & ToolSuccessMeta, CalcomError>> {
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>("/event-types")
  if (r.ok) {
    return {
      ok: true,
      data: {
        connected: true,
        event_types_count: (r.data.data ?? []).length,
        result_summary: "Connection verified",
      },
    }
  }
  if (r.error.code === "not_connected") {
    return { ok: true, data: { connected: false, result_summary: "Not connected" } }
  }
  return r as unknown as Result<{ connected: boolean } & ToolSuccessMeta, CalcomError>
}

// -------------------- Event Types --------------------

export interface ListEventTypesInput {
  username?: string
}
export async function listEventTypesImpl(
  input: ListEventTypesInput,
): Promise<Result<{ event_types: EventTypeSummary[] } & ToolSuccessMeta, CalcomError>> {
  const qs = input.username ? `?username=${encodeURIComponent(input.username)}` : ""
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>(`/event-types${qs}`)
  if (!r.ok) return r
  const event_types = (r.data.data ?? []).map(mapEventType)
  return {
    ok: true,
    data: {
      event_types,
      calcom_object: "event-types",
      result_summary: `Listed ${event_types.length} event type(s)`,
    },
  }
}

export interface GetEventTypeInput { event_type_id: string }
export async function getEventTypeImpl(
  input: GetEventTypeInput,
): Promise<Result<{ event_type: EventTypeSummary } & ToolSuccessMeta, CalcomError>> {
  const r = await apiGet<{ data: Record<string, unknown> }>(`/event-types/${input.event_type_id}`)
  if (!r.ok) return r
  const event_type = mapEventType(r.data.data ?? {})
  return {
    ok: true,
    data: {
      event_type,
      calcom_object: "event-types",
      calcom_record_id: event_type.id,
      calcom_deep_link: eventTypeDeepLink(event_type.id),
      result_summary: `Fetched event type "${event_type.title}"`,
    },
  }
}

// -------------------- Bookings --------------------

export interface ListBookingsInput {
  status?: "upcoming" | "past" | "cancelled" | "recurring"
  attendee_email?: string
  limit?: number
}
export async function listBookingsImpl(
  input: ListBookingsInput,
): Promise<Result<{ bookings: BookingSummary[] } & ToolSuccessMeta, CalcomError>> {
  const params = new URLSearchParams()
  if (input.status) params.set("status", input.status)
  if (input.attendee_email) params.set("attendeeEmail", input.attendee_email)
  params.set("take", String(input.limit ?? 20))
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>(`/bookings?${params.toString()}`)
  if (!r.ok) return r
  const bookings = (r.data.data ?? []).map(mapBooking)
  return {
    ok: true,
    data: {
      bookings,
      calcom_object: "bookings",
      result_summary: `Listed ${bookings.length} booking(s)`,
    },
  }
}

export interface GetBookingInput { booking_id: string }
export async function getBookingImpl(
  input: GetBookingInput,
): Promise<Result<{ booking: BookingSummary } & ToolSuccessMeta, CalcomError>> {
  const r = await apiGet<{ data: Record<string, unknown> }>(`/bookings/${input.booking_id}`)
  if (!r.ok) return r
  const booking = mapBooking(r.data.data ?? {})
  return {
    ok: true,
    data: {
      booking,
      calcom_object: "bookings",
      calcom_record_id: booking.id,
      calcom_deep_link: bookingDeepLink(booking.id),
      result_summary: `Fetched booking ${booking.id}`,
    },
  }
}

export interface CancelBookingInput { booking_id: string; reason?: string }
export async function cancelBookingImpl(
  input: CancelBookingInput,
): Promise<Result<{ booking_id: string } & ToolSuccessMeta, CalcomError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>(
    `/bookings/${input.booking_id}/cancel`,
    { cancellationReason: input.reason ?? "Cancelled via Holaboss" },
  )
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      booking_id: input.booking_id,
      calcom_object: "bookings",
      calcom_record_id: input.booking_id,
      calcom_deep_link: bookingDeepLink(input.booking_id),
      result_summary: `Cancelled booking ${input.booking_id}`,
    },
  }
}

export interface RescheduleBookingInput {
  booking_id: string
  new_start_time: string
  reason?: string
}
export async function rescheduleBookingImpl(
  input: RescheduleBookingInput,
): Promise<Result<{ new_booking_id: string } & ToolSuccessMeta, CalcomError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>(
    `/bookings/${input.booking_id}/reschedule`,
    {
      start: input.new_start_time,
      reschedulingReason: input.reason ?? "Rescheduled via Holaboss",
    },
  )
  if (!r.ok) return r
  const raw = r.data.data ?? {}
  const newId = String(raw.id ?? input.booking_id)
  return {
    ok: true,
    data: {
      new_booking_id: newId,
      calcom_object: "bookings",
      calcom_record_id: newId,
      calcom_deep_link: bookingDeepLink(newId),
      result_summary: `Rescheduled booking ${input.booking_id} → ${newId}`,
    },
  }
}

// -------------------- Availability --------------------

export interface ListAvailableSlotsInput {
  event_type_id: string
  start_date: string
  end_date: string
  timezone?: string
}
export async function listAvailableSlotsImpl(
  input: ListAvailableSlotsInput,
): Promise<Result<{ slots: AvailabilitySlot[] } & ToolSuccessMeta, CalcomError>> {
  const params = new URLSearchParams()
  params.set("eventTypeId", input.event_type_id)
  params.set("startTime", input.start_date)
  params.set("endTime", input.end_date)
  if (input.timezone) params.set("timeZone", input.timezone)
  const r = await apiGet<{ data: Record<string, Array<{ start: string; end: string }>> }>(`/slots?${params.toString()}`)
  if (!r.ok) return r
  const slots: AvailabilitySlot[] = []
  const byDay = r.data.data ?? {}
  for (const day of Object.keys(byDay)) {
    for (const s of byDay[day] ?? []) {
      slots.push({ start: s.start, end: s.end })
    }
  }
  return {
    ok: true,
    data: {
      slots,
      result_summary: `Found ${slots.length} available slot(s) between ${input.start_date} and ${input.end_date}`,
    },
  }
}

// -------------------- Registration --------------------

export function registerTools(server: McpServer): void {
  const getConnectionStatus = wrapTool("calcom_get_connection_status", getConnectionStatusImpl)
  const listEventTypes = wrapTool("calcom_list_event_types", listEventTypesImpl)
  const getEventType = wrapTool("calcom_get_event_type", getEventTypeImpl)
  const listBookings = wrapTool("calcom_list_bookings", listBookingsImpl)
  const getBooking = wrapTool("calcom_get_booking", getBookingImpl)
  const cancelBooking = wrapTool("calcom_cancel_booking", cancelBookingImpl)
  const rescheduleBooking = wrapTool("calcom_reschedule_booking", rescheduleBookingImpl)
  const listAvailableSlots = wrapTool("calcom_list_available_slots", listAvailableSlotsImpl)

  const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] })

  server.tool(
    "calcom_get_connection_status",
    "Check whether Cal.com is connected for this workspace. Returns { connected, event_types_count }. If not connected, tell the user to connect Cal.com from the Holaboss integrations page.",
    {},
    async () => asText(await getConnectionStatus({})),
  )

  server.tool(
    "calcom_list_event_types",
    "List the user's Cal.com event types. Each event type has a slug, title, length in minutes, description, and a booking_url that prospects can use to self-book a meeting. Use this to discover what kinds of meetings the user offers (e.g. '30-min intro', '60-min demo') before sharing a booking URL.",
    {
      username: z.string().optional().describe("Filter by a specific username; defaults to the connected user"),
    },
    async (args) => asText(await listEventTypes(args)),
  )

  server.tool(
    "calcom_get_event_type",
    "Fetch a single Cal.com event type by id, returning the full details including booking URL, length, and description.",
    {
      event_type_id: z.string().describe("Cal.com event type id"),
    },
    async (args) => asText(await getEventType(args)),
  )

  server.tool(
    "calcom_list_bookings",
    "List Cal.com bookings. Use status='upcoming' to see future meetings, 'past' for completed ones, 'cancelled' for cancellations. Filter by attendee_email to find meetings with a specific prospect.",
    {
      status: z.enum(["upcoming", "past", "cancelled", "recurring"]).optional().describe("Filter by booking status"),
      attendee_email: z.string().optional().describe("Filter by a specific attendee's email"),
      limit: z.number().int().positive().max(100).optional().describe("Max results, default 20"),
    },
    async (args) => asText(await listBookings(args)),
  )

  server.tool(
    "calcom_get_booking",
    "Fetch a single Cal.com booking by id, returning start/end time, attendees, status, and meeting URL.",
    {
      booking_id: z.string().describe("Cal.com booking id"),
    },
    async (args) => asText(await getBooking(args)),
  )

  server.tool(
    "calcom_cancel_booking",
    "Cancel an existing Cal.com booking. Always supply a reason — it will be sent to the attendee in the cancellation notification email.",
    {
      booking_id: z.string().describe("Cal.com booking id to cancel"),
      reason: z.string().optional().describe("Cancellation reason, included in attendee notification"),
    },
    async (args) => asText(await cancelBooking(args)),
  )

  server.tool(
    "calcom_reschedule_booking",
    "Reschedule an existing Cal.com booking to a new start time. The new_start_time must be an ISO 8601 string with an explicit timezone offset. The prospect receives a reschedule notification with the reason.",
    {
      booking_id: z.string().describe("Cal.com booking id to reschedule"),
      new_start_time: z.string().describe("New start time, ISO 8601 with timezone, e.g. '2026-04-21T14:00:00Z'"),
      reason: z.string().optional().describe("Rescheduling reason, included in attendee notification"),
    },
    async (args) => asText(await rescheduleBooking(args)),
  )

  server.tool(
    "calcom_list_available_slots",
    "List available time slots for an event type within a date range. Use this to answer 'when am I free next week for a 30-min intro?' before sharing a booking URL.",
    {
      event_type_id: z.string().describe("Event type id to check availability for"),
      start_date: z.string().describe("Start of range, ISO 8601 (e.g. '2026-04-20' or '2026-04-20T00:00:00Z')"),
      end_date: z.string().describe("End of range, ISO 8601"),
      timezone: z.string().optional().describe("IANA timezone for slot times, e.g. 'America/New_York'"),
    },
    async (args) => asText(await listAvailableSlots(args)),
  )
}