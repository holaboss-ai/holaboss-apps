// Canonical codes per ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md §"Errors".
export type ApolloErrorCode =
  | "not_found"
  | "invalid_state"
  | "validation_failed"
  | "not_connected"
  | "rate_limited"
  | "upstream_error"
  | "internal"

export interface ApolloError {
  code: ApolloErrorCode
  message: string
  retry_after?: number
}

export type Result<T, E = ApolloError> =
  | { ok: true; data: T }
  | { ok: false; error: E }

export interface PersonSummary {
  id: string
  name: string | null
  first_name: string | null
  last_name: string | null
  title: string | null
  email: string | null
  linkedin_url: string | null
  city: string | null
  state: string | null
  country: string | null
  organization: {
    id: string | null
    name: string | null
    domain: string | null
  } | null
}

export interface OrganizationSummary {
  id: string
  name: string | null
  domain: string | null
  website_url: string | null
  industry: string | null
  estimated_num_employees: number | null
  founded_year: number | null
  city: string | null
  state: string | null
  country: string | null
  technology_names: string[]
}

export interface SequenceSummary {
  id: string
  name: string
  active: boolean
  archived: boolean
  num_steps: number
  created_at: string | null
}

export interface EmailEvent {
  id: string
  contact_id: string | null
  emailer_campaign_id: string | null
  subject: string | null
  status: string | null
  sent_at: string | null
  opened_at: string | null
  replied_at: string | null
  bounced_at: string | null
  clicked_at: string | null
}

export interface PaginationSummary {
  page: number
  per_page: number
  total_entries: number | null
  total_pages: number | null
}

export interface AgentActionRecord {
  id: string
  timestamp: number
  tool_name: string
  args_json: string
  outcome: "success" | "error"
  duration_ms: number
  apollo_object: string | null
  apollo_record_id: string | null
  apollo_deep_link: string | null
  result_summary: string | null
  error_code: string | null
  error_message: string | null
}

export interface ToolSuccessMeta {
  apollo_object?: string
  apollo_record_id?: string
  apollo_deep_link?: string
  result_summary?: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
  brandColor: string
}

// Brand color: chose oklch(0.55 0.13 220) — a calm Apollo-leaning teal/blue.
// Picked per plan §10 question 4 (no Apollo brand asset on hand).
export const MODULE_CONFIG: PlatformConfig = {
  provider: "apollo",
  destination: "apollo",
  name: "Apollo",
  brandColor: "oklch(0.55 0.13 220)",
}
