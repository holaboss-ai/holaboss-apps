// Canonical codes per ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md §"Errors".
export type ZoomInfoErrorCode =
  | "not_found"
  | "invalid_state"
  | "validation_failed"
  | "not_connected"
  | "rate_limited"
  | "upstream_error"
  | "internal"

export interface ZoomInfoError {
  code: ZoomInfoErrorCode
  message: string
  retry_after?: number
}

export type Result<T, TError = ZoomInfoError> =
  | { ok: true; data: T }
  | { ok: false; error: TError }

export interface ContactSummary {
  id: string
  first_name: string | null
  last_name: string | null
  job_title: string | null
  management_level: string | null
  job_function: string | null
  company_id: string | null
  company_name: string | null
  company_domain: string | null
  location_country: string | null
  location_state: string | null
}

export interface ContactDetail extends ContactSummary {
  email: string | null
  direct_phone: string | null
  mobile_phone: string | null
  business_address: string | null
  linkedin_url: string | null
}

export interface CompanySummary {
  id: string
  name: string
  domain: string | null
  industry: string | null
  employee_count: number | null
  revenue: number | null
  location_country: string | null
}

export interface CompanyDetail extends CompanySummary {
  description: string | null
  founded_year: number | null
  technologies: Array<string>
  employee_count_by_department: Record<string, number>
  recent_news: Array<string>
  linkedin_url: string | null
}

export interface IntentTopic {
  topic: string
  score: number
  trending_since: string | null
}

export interface ExecutiveSummary {
  id: string
  first_name: string | null
  last_name: string | null
  job_title: string | null
  management_level: string | null
  job_function: string | null
}

export interface AgentActionRecord {
  id: string
  timestamp: number
  tool_name: string
  args_json: string
  outcome: "success" | "error"
  duration_ms: number
  zoominfo_object: string | null
  zoominfo_record_id: string | null
  zoominfo_deep_link: string | null
  result_summary: string | null
  error_code: string | null
  error_message: string | null
}

export interface ToolSuccessMeta {
  zoominfo_object?: string
  zoominfo_record_id?: string
  zoominfo_deep_link?: string
  result_summary?: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
  brandColor: string
}

// Brand color picked per plan §10 open question (navy blue assumption).
// See docs/plans/zoominfo.md §10 — defaulted to oklch(0.32 0.10 250) per
// task instructions (no human input received).
export const MODULE_CONFIG: PlatformConfig = {
  provider: "zoominfo",
  destination: "zoominfo",
  name: "ZoomInfo",
  brandColor: "oklch(0.32 0.10 250)",
}
