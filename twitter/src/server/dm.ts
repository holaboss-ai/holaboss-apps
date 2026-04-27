/**
 * Direct-message tool implementations for the Twitter / X module.
 *
 * Two operations, both keyed on the recipient's X numeric user ID
 * (`participant_id`):
 *   - `sendDirectMessage(participant_id, text)` — send a DM. Works for both
 *     initiating a new conversation and continuing an existing one (X's
 *     `/2/dm_conversations/with/{participant_id}/messages` endpoint covers
 *     both cases).
 *   - `listDirectMessages(participant_id, …)` — read recent DM events from
 *     the conversation with that user, ordered newest-first per X.
 *
 * No local persistence: every call is a pass-through to X via the Composio
 * proxy. No drafts, no schedule, no inbox aggregation. By design — see the
 * design conversation in 2026-04-27.
 *
 * Error envelope follows the canonical 7-code shape used across the
 * `hola-boss-apps` modules; consumers in `mcp.ts` translate `Result` into
 * MCP `success()` / `errCode()`.
 */
import { createIntegrationClient } from "./holaboss-bridge"

const X_API_BASE = "https://api.twitter.com/2"

// Hard cap on a single DM body. Practical limit X enforces for v2 DMs is
// 10,000 characters; hitting the boundary trips a 400 from X. Validate
// up-front so we don't burn a quota call on a payload that's obviously
// rejected.
const DM_TEXT_MAX = 10_000

// Default + ceiling for `max_results` on listDirectMessages. X caps at 100
// per page; defaulting to 50 keeps payloads small for typical agent reads.
const DM_LIST_DEFAULT = 50
const DM_LIST_MAX = 100

// dm_event.fields the agent actually needs. X returns only `id, event_type`
// by default, which omits the message body — useless for our use case.
const DM_EVENT_FIELDS = "id,event_type,text,sender_id,created_at,dm_conversation_id"

export type DmErrorCode =
  | "not_found"
  | "validation_failed"
  | "not_connected"
  | "rate_limited"
  | "upstream_error"
  | "internal"

export interface DmError {
  code: DmErrorCode
  message: string
  retry_after?: number
}

export type Result<T, E = DmError> =
  | { ok: true; data: T }
  | { ok: false; error: E }

type HttpMethod = "GET" | "POST"

export interface BridgeLike {
  proxy<T = unknown>(req: {
    method: HttpMethod
    endpoint: string
    body?: unknown
  }): Promise<{ data: T | null; status: number; headers: Record<string, string> }>
}

let _client: BridgeLike | null = null

function defaultClient(): BridgeLike {
  return createIntegrationClient("twitter") as BridgeLike
}

function getClient(): BridgeLike {
  if (!_client) _client = defaultClient()
  return _client
}

export function setBridgeClient(client: BridgeLike | null): void {
  _client = client
}

export function resetBridgeClient(): void {
  _client = null
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"] ?? headers["Retry-After"]
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function isNotConnectedError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message.toLowerCase()
  return (
    msg.includes("no twitter integration") ||
    msg.includes("not connected") ||
    msg.includes("connect via integrations")
  )
}

function extractErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  if (typeof d.title === "string" && typeof d.detail === "string") {
    // X's standard problem+json shape
    return `${d.title}: ${d.detail}`
  }
  if (typeof d.detail === "string") return d.detail
  if (typeof d.title === "string") return d.title
  if (typeof d.message === "string") return d.message
  if (Array.isArray(d.errors) && d.errors.length > 0) {
    const first = d.errors[0]
    if (typeof first === "string") return first
    if (first && typeof first === "object") {
      const msg = (first as Record<string, unknown>).message
      if (typeof msg === "string") return msg
    }
  }
  return undefined
}

/**
 * Map a proxy response (or thrown bridge error) to a `Result<T, DmError>`.
 *
 * 2xx           → ok
 * 401 / 403     → not_connected (auth / scope missing — caller needs to reconnect)
 * 404           → not_found (participant_id invalid OR conversation never started)
 * 422 / other 4xx → validation_failed (e.g. text too long, recipient closed DMs)
 * 429           → rate_limited with retry_after when X surfaces it
 * 5xx           → upstream_error
 * thrown error  → not_connected (if message looks like a missing integration) or upstream_error
 */
async function call<T>(method: HttpMethod, endpoint: string, body?: unknown): Promise<Result<T>> {
  const client = getClient()
  let resp: { data: T | null; status: number; headers: Record<string, string> }
  try {
    resp = await client.proxy<T>({ method, endpoint, body })
  } catch (e) {
    if (isNotConnectedError(e)) {
      return { ok: false, error: { code: "not_connected", message: "Twitter is not connected for this workspace." } }
    }
    return { ok: false, error: { code: "upstream_error", message: e instanceof Error ? e.message : String(e) } }
  }

  if (resp.status >= 200 && resp.status < 300) {
    return { ok: true, data: resp.data as T }
  }
  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      error: {
        code: "not_connected",
        message: extractErrorMessage(resp.data) ?? "X credentials rejected (token expired or DM scope missing).",
      },
    }
  }
  if (resp.status === 404) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: extractErrorMessage(resp.data) ?? "X user not found, or no DM conversation exists yet.",
      },
    }
  }
  if (resp.status === 429) {
    return {
      ok: false,
      error: {
        code: "rate_limited",
        message: extractErrorMessage(resp.data) ?? "X DM rate limit exceeded.",
        retry_after: parseRetryAfter(resp.headers),
      },
    }
  }
  if (resp.status >= 400 && resp.status < 500) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: extractErrorMessage(resp.data) ?? `X DM API returned HTTP ${resp.status}.`,
      },
    }
  }
  return {
    ok: false,
    error: {
      code: "upstream_error",
      message: extractErrorMessage(resp.data) ?? `X DM API returned HTTP ${resp.status}.`,
    },
  }
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

export interface SendDirectMessageInput {
  participant_id: string
  text: string
}

export interface SendDirectMessageOutput {
  dm_event_id: string
  dm_conversation_id: string
}

export async function sendDirectMessage(
  input: SendDirectMessageInput,
): Promise<Result<SendDirectMessageOutput>> {
  const participant = (input.participant_id ?? "").trim()
  if (!participant) {
    return { ok: false, error: { code: "validation_failed", message: "participant_id is required." } }
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    return { ok: false, error: { code: "validation_failed", message: "text is required and must be non-empty." } }
  }
  if (input.text.length > DM_TEXT_MAX) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: `text exceeds the ${DM_TEXT_MAX}-character X DM limit (got ${input.text.length}).`,
      },
    }
  }

  const result = await call<{ data: { dm_event_id: string; dm_conversation_id: string } }>(
    "POST",
    `${X_API_BASE}/dm_conversations/with/${encodeURIComponent(participant)}/messages`,
    { text: input.text },
  )
  if (!result.ok) return { ok: false, error: result.error }
  const payload = result.data?.data
  if (!payload?.dm_event_id || !payload?.dm_conversation_id) {
    return {
      ok: false,
      error: {
        code: "upstream_error",
        message: "X returned 2xx but the response was missing dm_event_id / dm_conversation_id.",
      },
    }
  }
  return {
    ok: true,
    data: { dm_event_id: payload.dm_event_id, dm_conversation_id: payload.dm_conversation_id },
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListDirectMessagesInput {
  participant_id: string
  max_results?: number
  pagination_token?: string
}

/**
 * A normalised DM event. The agent typically only cares about
 * `event_type === "MessageCreate"`; we surface other event types
 * (ParticipantsJoin / ParticipantsLeave) as-is so the caller can filter.
 */
export interface DmEvent {
  dm_event_id: string
  dm_conversation_id: string
  event_type: string
  text?: string
  sender_id?: string
  created_at?: string
}

export interface ListDirectMessagesOutput {
  messages: DmEvent[]
  result_count: number
  next_pagination_token?: string
}

interface RawDmEvent {
  id: string
  event_type: string
  text?: string
  sender_id?: string
  created_at?: string
  dm_conversation_id?: string
}

export async function listDirectMessages(
  input: ListDirectMessagesInput,
): Promise<Result<ListDirectMessagesOutput>> {
  const participant = (input.participant_id ?? "").trim()
  if (!participant) {
    return { ok: false, error: { code: "validation_failed", message: "participant_id is required." } }
  }

  const max = Math.min(Math.max(input.max_results ?? DM_LIST_DEFAULT, 1), DM_LIST_MAX)
  const params = new URLSearchParams({
    max_results: String(max),
    "dm_event.fields": DM_EVENT_FIELDS,
  })
  if (input.pagination_token?.trim()) {
    params.set("pagination_token", input.pagination_token.trim())
  }

  const result = await call<{
    data?: RawDmEvent[]
    meta?: { result_count?: number; next_token?: string }
  }>(
    "GET",
    `${X_API_BASE}/dm_conversations/with/${encodeURIComponent(participant)}/dm_events?${params.toString()}`,
  )
  if (!result.ok) return { ok: false, error: result.error }

  const events = (result.data?.data ?? []).map(
    (e): DmEvent => ({
      dm_event_id: e.id,
      dm_conversation_id: e.dm_conversation_id ?? "",
      event_type: e.event_type,
      text: e.text,
      sender_id: e.sender_id,
      created_at: e.created_at,
    }),
  )
  return {
    ok: true,
    data: {
      messages: events,
      result_count: result.data?.meta?.result_count ?? events.length,
      next_pagination_token: result.data?.meta?.next_token,
    },
  }
}
