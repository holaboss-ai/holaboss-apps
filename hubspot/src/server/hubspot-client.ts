import { createIntegrationClient } from "./holaboss-bridge"
import type { HubspotError, Result } from "../lib/types"

// HubSpot REST API base. The bridge proxies the FULL URL through to HubSpot.
// Per Phase 0 verification (developers.hubspot.com 2026-04 docs):
//   - /crm/v3/* and /crm/<dated>/* both work; we use /crm/v3 for stability.
//   - Search requires POST to /crm/v3/objects/{type}/search with `filterGroups`.
//   - Notes/tasks engagements live under /crm/v3/objects/notes & .../tasks
//     and use numeric `associationTypeId` with `associationCategory: "HUBSPOT_DEFINED"`.
//   - Portal id comes from `GET /account-info/v3/details` (Bearer token only).
const HUBSPOT_BASE = "https://api.hubapi.com"

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE"

export interface BridgeLike {
  proxy<T = unknown>(req: {
    method: HttpMethod
    endpoint: string
    body?: unknown
  }): Promise<{ data: T | null; status: number; headers: Record<string, string> }>
}

let _client: BridgeLike | null = null

function defaultClient(): BridgeLike {
  return createIntegrationClient("hubspot") as BridgeLike
}

export function getBridgeClient(): BridgeLike {
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
    msg.includes("no hubspot integration") ||
    msg.includes("not connected") ||
    msg.includes("connect via integrations")
  )
}

/**
 * HubSpot returns errors as
 *   { status, message, correlationId, category, errors?: [...], context?: {...} }
 * On 403 the `category` is often `MISSING_SCOPES` and `context.requiredScopes` lists them.
 */
function extractErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  if (typeof d.message === "string") return d.message
  if (typeof d.error === "string") return d.error
  if (d.error && typeof d.error === "object") {
    const inner = (d.error as Record<string, unknown>).message
    if (typeof inner === "string") return inner
  }
  return undefined
}

function extractMissingScopes(data: unknown): string[] | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  const ctx = d.context as Record<string, unknown> | undefined
  if (ctx && Array.isArray(ctx.requiredScopes)) {
    return (ctx.requiredScopes as unknown[]).map((s) => String(s))
  }
  return undefined
}

export async function call<T>(
  method: HttpMethod,
  endpoint: string,
  body?: unknown,
): Promise<Result<T, HubspotError>> {
  const client = getBridgeClient()
  let resp
  try {
    resp = await client.proxy<T>({
      method,
      endpoint: `${HUBSPOT_BASE}${endpoint}`,
      body,
    })
  } catch (e) {
    if (isNotConnectedError(e)) {
      return {
        ok: false,
        error: {
          code: "not_connected",
          message: "HubSpot is not connected for this workspace.",
        },
      }
    }
    return {
      ok: false,
      error: {
        code: "upstream_error",
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }

  if (resp.status >= 200 && resp.status < 300) {
    return { ok: true, data: resp.data as T }
  }
  if (resp.status === 401) {
    return {
      ok: false,
      error: {
        code: "not_connected",
        message: extractErrorMessage(resp.data) ?? "HubSpot rejected the access token (401).",
      },
    }
  }
  if (resp.status === 403) {
    // 403 in HubSpot most commonly means a missing OAuth scope.
    const missing = extractMissingScopes(resp.data)
    const baseMsg = extractErrorMessage(resp.data) ?? "HubSpot returned 403."
    const message = missing && missing.length > 0
      ? `scope missing: ${missing.join(", ")} — ${baseMsg}`
      : baseMsg
    return {
      ok: false,
      error: { code: "not_connected", message },
    }
  }
  if (resp.status === 404) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: extractErrorMessage(resp.data) ?? "HubSpot record not found.",
      },
    }
  }
  if (resp.status === 429) {
    // Plan §10: surface 429, do NOT auto-retry. The agent decides.
    return {
      ok: false,
      error: {
        code: "rate_limited",
        message: "HubSpot API rate limit exceeded.",
        retry_after: parseRetryAfter(resp.headers),
      },
    }
  }
  if (resp.status >= 400 && resp.status < 500) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: extractErrorMessage(resp.data) ?? `HubSpot returned HTTP ${resp.status}.`,
      },
    }
  }
  return {
    ok: false,
    error: {
      code: "upstream_error",
      message: extractErrorMessage(resp.data) ?? `HubSpot returned HTTP ${resp.status}.`,
    },
  }
}

export const apiGet = <T>(endpoint: string) => call<T>("GET", endpoint)
export const apiPost = <T>(endpoint: string, body: unknown) => call<T>("POST", endpoint, body)
export const apiPatch = <T>(endpoint: string, body: unknown) => call<T>("PATCH", endpoint, body)
export const apiDelete = <T>(endpoint: string) => call<T>("DELETE", endpoint)

// Deep-link helpers — Plan §6.
// HubSpot record URLs follow:
//   https://app.hubspot.com/contacts/{portalId}/contact/{id}
//   https://app.hubspot.com/contacts/{portalId}/company/{id}
//   https://app.hubspot.com/contacts/{portalId}/deal/{id}
// Notes/tasks don't have direct deep links; we link to the parent record instead.
export function contactDeepLink(portalId: string, contactId: string): string {
  return `https://app.hubspot.com/contacts/${portalId}/contact/${contactId}`
}
export function companyDeepLink(portalId: string, companyId: string): string {
  return `https://app.hubspot.com/contacts/${portalId}/company/${companyId}`
}
export function dealDeepLink(portalId: string, dealId: string): string {
  return `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`
}
export function deepLinkFor(
  portalId: string,
  parent: "contacts" | "companies" | "deals",
  id: string,
): string {
  if (parent === "contacts") return contactDeepLink(portalId, id)
  if (parent === "companies") return companyDeepLink(portalId, id)
  return dealDeepLink(portalId, id)
}
