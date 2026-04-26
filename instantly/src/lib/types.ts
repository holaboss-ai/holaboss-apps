// Canonical codes per ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md §"Errors".
export type InstantlyErrorCode =
  | "not_found"
  | "invalid_state"
  | "validation_failed"
  | "not_connected"
  | "rate_limited"
  | "upstream_error"
  | "internal"

export interface InstantlyError {
  code: InstantlyErrorCode
  message: string
  retry_after?: number
}

export type Result<T, E = InstantlyError> =
  | { ok: true; data: T }
  | { ok: false; error: E }

export type CampaignStatus = "active" | "paused" | "draft" | "completed"

export interface CampaignSummary {
  id: string
  name: string
  status: CampaignStatus
  lead_count: number | null
  last_activity_at: string | null
}

export interface CampaignSchedule {
  timezone: string | null
  send_days: string[]
  send_window: { start: string | null; end: string | null }
}

export interface CampaignStep {
  step_index: number
  delay_days: number | null
  subject: string | null
  body_preview: string | null
}

export interface CampaignDetails {
  id: string
  name: string
  status: CampaignStatus
  schedule: CampaignSchedule
  steps: CampaignStep[]
  sending_accounts: string[]
}

export type LeadStatus =
  | "active"
  | "replied"
  | "bounced"
  | "unsubscribed"
  | "completed"

export interface LeadSummary {
  lead_id: string
  email: string
  first_name: string | null
  last_name: string | null
  status: LeadStatus
  added_at: string | null
  last_contacted_at: string | null
}

export interface CampaignStats {
  sent: number
  delivered: number
  opened: number
  replied: number
  bounced: number
  unsubscribed: number
  open_rate: number
  reply_rate: number
  bounce_rate: number
}

export interface AgentActionRecord {
  id: string
  timestamp: number
  tool_name: string
  args_json: string
  outcome: "success" | "error"
  duration_ms: number
  instantly_object: string | null
  instantly_record_id: string | null
  instantly_deep_link: string | null
  result_summary: string | null
  error_code: string | null
  error_message: string | null
}

export interface ToolSuccessMeta {
  instantly_object?: string
  instantly_record_id?: string
  instantly_deep_link?: string
  result_summary?: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
  brandColor: string
}

// Brand color: oklch(0.65 0.22 32) — Instantly's bright orange-red anchor.
export const MODULE_CONFIG: PlatformConfig = {
  provider: "instantly",
  destination: "instantly",
  name: "Instantly",
  brandColor: "oklch(0.65 0.22 32)",
}
