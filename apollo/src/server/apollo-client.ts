import { createIntegrationClient } from "./holaboss-bridge"
import type { ApolloError, Result } from "../lib/types"

// Apollo's REST surface is rooted at /api/v1 (not /v1).
// Verified from docs.apollo.io 2026-04 — the few legacy endpoints under /v1
// (e.g. /v1/auth/health) are unauthenticated test pings, not the work API.
const APOLLO_BASE = "https://api.apollo.io/api/v1"

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface BridgeLike {
  proxy<T = unknown>(req: {
    method: HttpMethod
    endpoint: string
    body?: unknown
  }): Promise<{ data: T | null; status: number; headers: Record<string, string> }>
}

let _client: BridgeLike | null = null

function defaultClient(): BridgeLike {
  return createIntegrationClient("apollo") as BridgeLike
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
    msg.includes("no apollo integration") ||
    msg.includes("not connected") ||
    msg.includes("connect via integrations")
  )
}

function extractErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  if (typeof d.message === "string") return d.message
  if (typeof d.error === "string") return d.error
  if (typeof d.error_message === "string") return d.error_message
  if (Array.isArray(d.errors) && d.errors.length > 0) {
    const first = d.errors[0]
    if (typeof first === "string") return first
    if (first && typeof first === "object" && typeof (first as Record<string, unknown>).message === "string") {
      return String((first as Record<string, unknown>).message)
    }
  }
  if (d.error && typeof d.error === "object") {
    const inner = (d.error as Record<string, unknown>).message
    if (typeof inner === "string") return inner
  }
  return undefined
}

export async function call<T>(
  method: HttpMethod,
  endpoint: string,
  body?: unknown,
): Promise<Result<T, ApolloError>> {
  const client = getBridgeClient()
  let resp
  try {
    resp = await client.proxy<T>({
      method,
      endpoint: `${APOLLO_BASE}${endpoint}`,
      body,
    })
  } catch (e) {
    if (isNotConnectedError(e)) {
      return {
        ok: false,
        error: {
          code: "not_connected",
          message: "Apollo is not connected for this workspace.",
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
  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      error: {
        code: "not_connected",
        message: extractErrorMessage(resp.data) ?? "Apollo credential rejected.",
      },
    }
  }
  if (resp.status === 404) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: extractErrorMessage(resp.data) ?? "Apollo resource not found.",
      },
    }
  }
  if (resp.status === 429) {
    return {
      ok: false,
      error: {
        code: "rate_limited",
        message: "Apollo API rate limit exceeded.",
        retry_after: parseRetryAfter(resp.headers),
      },
    }
  }
  if (resp.status === 422) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: extractErrorMessage(resp.data) ?? `Apollo returned HTTP ${resp.status}.`,
      },
    }
  }
  if (resp.status >= 400 && resp.status < 500) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: extractErrorMessage(resp.data) ?? `Apollo returned HTTP ${resp.status}.`,
      },
    }
  }
  return {
    ok: false,
    error: {
      code: "upstream_error",
      message: extractErrorMessage(resp.data) ?? `Apollo returned HTTP ${resp.status}.`,
    },
  }
}

export const apiGet = <T>(endpoint: string) => call<T>("GET", endpoint)
export const apiPost = <T>(endpoint: string, body: unknown) => call<T>("POST", endpoint, body)
export const apiPatch = <T>(endpoint: string, body: unknown) => call<T>("PATCH", endpoint, body)
export const apiDelete = <T>(endpoint: string) => call<T>("DELETE", endpoint)
