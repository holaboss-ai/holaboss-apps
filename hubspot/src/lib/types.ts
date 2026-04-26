// Canonical codes per ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md §"Errors".
export type HubspotErrorCode =
  | "not_found"
  | "invalid_state"
  | "validation_failed"
  | "not_connected"
  | "rate_limited"
  | "upstream_error"
  | "internal"

export interface HubspotError {
  code: HubspotErrorCode
  message: string
  retry_after?: number
}

export type Result<T, E = HubspotError> =
  | { ok: true; data: T }
  | { ok: false; error: E }

export interface HubspotRecord {
  id: string
  properties: Record<string, unknown>
}

export interface AgentActionRecord {
  id: string
  timestamp: number
  tool_name: string
  args_json: string
  outcome: "success" | "error"
  duration_ms: number
  hubspot_object: string | null
  hubspot_record_id: string | null
  hubspot_deep_link: string | null
  result_summary: string | null
  error_code: string | null
  error_message: string | null
}

export interface ToolSuccessMeta {
  hubspot_object?: string
  hubspot_record_id?: string
  hubspot_deep_link?: string
  result_summary?: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
  brandColor: string
}

// Brand color: HubSpot orange (#FF7A59 ≈ oklch(0.71 0.16 35)).
export const MODULE_CONFIG: PlatformConfig = {
  provider: "hubspot",
  destination: "hubspot",
  name: "HubSpot CRM",
  brandColor: "oklch(0.71 0.16 35)",
}
