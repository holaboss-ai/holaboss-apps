export type CalcomErrorCode =
  | "not_connected"
  | "rate_limited"
  | "validation_failed"
  | "upstream_error"

export interface CalcomError {
  code: CalcomErrorCode
  message: string
  retry_after?: number
}

export type Result<T, E = CalcomError> =
  | { ok: true; data: T }
  | { ok: false; error: E }

export interface EventTypeSummary {
  id: string
  slug: string
  title: string
  length_minutes: number
  description: string | null
  booking_url: string
  location_type: string | null
}

export interface BookingAttendee {
  name: string
  email: string
  timezone?: string
}

export interface BookingSummary {
  id: string
  title: string
  start_time: string
  end_time: string
  status: string
  event_type_id: string | null
  attendees: BookingAttendee[]
  location: string | null
  meeting_url: string | null
}

export interface AvailabilitySlot {
  start: string
  end: string
}

export interface AgentActionRecord {
  id: string
  timestamp: number
  tool_name: string
  args_json: string
  outcome: "success" | "error"
  duration_ms: number
  calcom_object: string | null
  calcom_record_id: string | null
  calcom_deep_link: string | null
  result_summary: string | null
  error_code: string | null
  error_message: string | null
}

export interface ToolSuccessMeta {
  calcom_object?: string
  calcom_record_id?: string
  calcom_deep_link?: string
  result_summary?: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
  brandColor: string
}

export const MODULE_CONFIG: PlatformConfig = {
  provider: "calcom",
  destination: "calcom",
  name: "Cal.com",
  brandColor: "oklch(0.2 0 0)",
}