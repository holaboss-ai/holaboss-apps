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
  return { ok: false, error: r.error }
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
// Tool descriptions follow ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md

export function registerTools(server: McpServer): void {
  const getConnectionStatus = wrapTool("calcom_get_connection_status", getConnectionStatusImpl)
  const listEventTypes = wrapTool("calcom_list_event_types", listEventTypesImpl)
  const getEventType = wrapTool("calcom_get_event_type", getEventTypeImpl)
  const listBookings = wrapTool("calcom_list_bookings", listBookingsImpl)
  const getBooking = wrapTool("calcom_get_booking", getBookingImpl)
  const cancelBooking = wrapTool("calcom_cancel_booking", cancelBookingImpl)
  const rescheduleBooking = wrapTool("calcom_reschedule_booking", rescheduleBookingImpl)
  const listAvailableSlots = wrapTool("calcom_list_available_slots", listAvailableSlotsImpl)

  const asText = (result: Result<unknown, CalcomError>) => {
    if (result.ok) {
      // structuredContent matches the tool's outputSchema (when set).
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
        structuredContent: result.data as Record<string, unknown>,
      }
    }
    // Flat error envelope per docs/MCP_TOOL_DESCRIPTION_CONVENTION.md §"Errors".
    return { content: [{ type: "text" as const, text: JSON.stringify(result.error) }], isError: true as const }
  }

  // Output shapes
  const EventTypeSchema = z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    length_minutes: z.number(),
    description: z.string().nullable(),
    booking_url: z.string(),
    location_type: z.string().nullable(),
  })
  const BookingAttendeeSchema = z.object({
    name: z.string(),
    email: z.string(),
    timezone: z.string().optional(),
  })
  const BookingSchema = z.object({
    id: z.string(),
    title: z.string(),
    start_time: z.string(),
    end_time: z.string(),
    status: z.string(),
    event_type_id: z.string().nullable(),
    attendees: z.array(BookingAttendeeSchema),
    location: z.string().nullable(),
    meeting_url: z.string().nullable(),
  })
  const ToolSuccessMetaShape = {
    calcom_object: z.string().optional(),
    calcom_record_id: z.string().optional(),
    calcom_deep_link: z.string().optional(),
    result_summary: z.string().optional(),
  }
  const ConnectionStatusShape = {
    connected: z.boolean(),
    event_types_count: z.number().optional(),
    ...ToolSuccessMetaShape,
  }
  const EventTypesListShape = { event_types: z.array(EventTypeSchema), ...ToolSuccessMetaShape }
  const EventTypeOneShape = { event_type: EventTypeSchema, ...ToolSuccessMetaShape }
  const BookingsListShape = { bookings: z.array(BookingSchema), ...ToolSuccessMetaShape }
  const BookingOneShape = { booking: BookingSchema, ...ToolSuccessMetaShape }
  const CancelBookingShape = { booking_id: z.string(), ...ToolSuccessMetaShape }
  const RescheduleBookingShape = { new_booking_id: z.string(), ...ToolSuccessMetaShape }
  const SlotsListShape = {
    slots: z.array(z.object({ start: z.string(), end: z.string() })),
    ...ToolSuccessMetaShape,
  }

  server.registerTool(
    "calcom_get_connection_status",
    {
      title: "Check Cal.com connection",
      description: `Check whether Cal.com is connected for this workspace.

When to use: ALWAYS call this first if a Cal.com tool returns a not_connected error, or before suggesting Cal.com features to a user for the first time.
Returns: { connected: true, event_types_count } if linked, { connected: false } otherwise. If false, tell the user to connect Cal.com from the Holaboss integrations page.`,
      inputSchema: {},
      outputSchema: ConnectionStatusShape,
      annotations: {
        title: "Check Cal.com connection",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => asText(await getConnectionStatus({})),
  )

  server.registerTool(
    "calcom_list_event_types",
    {
      title: "List event types",
      description: `List the user's Cal.com event types — the meeting templates prospects can self-book.

When to use: discover what kinds of meetings the user offers (e.g. '30-min intro', '60-min demo') before sharing a booking URL.
Returns: array of { id, slug, title, length_minutes, description, booking_url, location_type }. booking_url is the public scheduling link to share with prospects.
Errors: { error: { code: 'not_connected' } } if Cal.com isn't linked — call calcom_get_connection_status to confirm.`,
      inputSchema: {
        username: z
          .string()
          .optional()
          .describe("Filter by a specific Cal.com username. Omit to use the connected workspace user."),
      },
      outputSchema: EventTypesListShape,
      annotations: {
        title: "List event types",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await listEventTypes(args)),
  )

  server.registerTool(
    "calcom_get_event_type",
    {
      title: "Get event type",
      description: `Fetch a single Cal.com event type by id, including booking URL, length, description.

Prerequisites: event_type_id from calcom_list_event_types.
Returns: { event_type: { id, slug, title, length_minutes, description, booking_url, location_type }, calcom_deep_link }.`,
      inputSchema: {
        event_type_id: z.string().describe("Cal.com event type id, e.g. '12345' (from calcom_list_event_types)."),
      },
      outputSchema: EventTypeOneShape,
      annotations: {
        title: "Get event type",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await getEventType(args)),
  )

  server.registerTool(
    "calcom_list_bookings",
    {
      title: "List bookings",
      description: `List Cal.com bookings, optionally filtered by status and attendee.

When to use: "what meetings do I have next week?" → status='upcoming'. "Did Bob ever book?" → attendee_email='bob@x.com'.
Returns: array of { id, title, start_time, end_time, status, event_type_id, attendees: [{ name, email, timezone? }], location?, meeting_url? }.`,
      inputSchema: {
        status: z
          .enum(["upcoming", "past", "cancelled", "recurring"])
          .optional()
          .describe("Filter: 'upcoming' for future meetings, 'past' for completed, 'cancelled' for cancellations."),
        attendee_email: z
          .string()
          .optional()
          .describe("Exact attendee email to filter by, e.g. 'alice@example.com'."),
        limit: z.number().int().positive().max(100).optional().describe("Max results, default 20, max 100."),
      },
      outputSchema: BookingsListShape,
      annotations: {
        title: "List bookings",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await listBookings(args)),
  )

  server.registerTool(
    "calcom_get_booking",
    {
      title: "Get booking",
      description: `Fetch a single Cal.com booking by id with attendees, status, and meeting URL.

Prerequisites: booking_id from calcom_list_bookings.
Returns: { booking: { id, title, start_time, end_time, status, attendees, location?, meeting_url? }, calcom_deep_link }.`,
      inputSchema: {
        booking_id: z.string().describe("Cal.com booking id (from calcom_list_bookings)."),
      },
      outputSchema: BookingOneShape,
      annotations: {
        title: "Get booking",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await getBooking(args)),
  )

  server.registerTool(
    "calcom_cancel_booking",
    {
      title: "Cancel booking",
      description: `Cancel an existing Cal.com booking. The attendee receives a cancellation notification email containing the reason.

When to use: the user wants to call off a meeting that's already booked.
Prerequisites: booking_id from calcom_list_bookings.
Side effects: emails the attendee. Cannot be undone — to recover, ask the user to rebook from a fresh slot.
Returns: { booking_id, calcom_deep_link, result_summary }.`,
      inputSchema: {
        booking_id: z.string().describe("Cal.com booking id to cancel."),
        reason: z
          .string()
          .optional()
          .describe("Reason for cancellation; included verbatim in the attendee notification. Default 'Cancelled via Holaboss'."),
      },
      outputSchema: CancelBookingShape,
      annotations: {
        title: "Cancel booking",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await cancelBooking(args)),
  )

  server.registerTool(
    "calcom_reschedule_booking",
    {
      title: "Reschedule booking",
      description: `Reschedule an existing Cal.com booking to a new start time. The attendee receives a reschedule notification email.

When to use: the user wants to move an existing meeting to a different time.
Prerequisites: booking_id from calcom_list_bookings; verify the new slot is free with calcom_list_available_slots.
Side effects: emails the attendee with the reason. Cal.com may issue a NEW booking id; use new_booking_id from the result, not the original.
Returns: { new_booking_id, calcom_deep_link, result_summary }.`,
      inputSchema: {
        booking_id: z.string().describe("Cal.com booking id to reschedule."),
        new_start_time: z
          .string()
          .describe("New start time, ISO 8601 with timezone, e.g. '2026-04-21T14:00:00Z'. Must match a free slot — check calcom_list_available_slots first."),
        reason: z
          .string()
          .optional()
          .describe("Reason for the change; included verbatim in the attendee notification. Default 'Rescheduled via Holaboss'."),
      },
      outputSchema: RescheduleBookingShape,
      annotations: {
        title: "Reschedule booking",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => asText(await rescheduleBooking(args)),
  )

  server.registerTool(
    "calcom_list_available_slots",
    {
      title: "List available slots",
      description: `List available time slots for an event type within a date range.

When to use: answer "when am I free next week for a 30-min intro?" before sharing a booking URL or before calling calcom_reschedule_booking.
Prerequisites: event_type_id from calcom_list_event_types.
Returns: { slots: [{ start, end }] } in ISO 8601. Empty array means no availability — widen the date range or relax timezone.`,
      inputSchema: {
        event_type_id: z.string().describe("Event type id to check availability for (from calcom_list_event_types)."),
        start_date: z
          .string()
          .describe("Start of range, ISO 8601, e.g. '2026-04-20' or '2026-04-20T00:00:00Z'."),
        end_date: z.string().describe("End of range, ISO 8601, e.g. '2026-04-27'."),
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone for slot times, e.g. 'America/New_York' or 'Europe/Berlin'."),
      },
      outputSchema: SlotsListShape,
      annotations: {
        title: "List available slots",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await listAvailableSlots(args)),
  )
}