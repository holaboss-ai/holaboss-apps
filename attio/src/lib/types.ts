export type AttioErrorCode =
  | "not_connected"
  | "rate_limited"
  | "validation_failed"
  | "upstream_error"

export interface AttioError {
  code: AttioErrorCode
  message: string
  retry_after?: number
}

export type Result<T, E = AttioError> =
  | { ok: true; data: T }
  | { ok: false; error: E }

export interface AttioRecord {
  id: string
  values: Record<string, unknown>
}

export interface AgentActionRecord {
  id: string
  timestamp: number
  tool_name: string
  args_json: string
  outcome: "success" | "error"
  duration_ms: number
  attio_object: string | null
  attio_record_id: string | null
  attio_deep_link: string | null
  result_summary: string | null
  error_code: string | null
  error_message: string | null
}

export interface ToolSuccessMeta {
  attio_object?: string
  attio_record_id?: string
  attio_deep_link?: string
  result_summary?: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
  brandColor: string
}

export const MODULE_CONFIG: PlatformConfig = {
  provider: "attio",
  destination: "attio",
  name: "Attio CRM",
  brandColor: "oklch(0.248 0.006 270)",
}
