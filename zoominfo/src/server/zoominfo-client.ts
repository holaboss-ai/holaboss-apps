/**
 * ZoomInfo API client.
 *
 * All requests go through the @holaboss/bridge integration broker via
 * `createIntegrationClient("zoominfo")`. The broker handles ZoomInfo's
 * authenticate-then-bearer-JWT flow internally — this module only deals
 * with the data plane.
 *
 * Compliance reminder: ZoomInfo data is licensed. Module callers must only
 * use it to populate the user's own CRM — never persist it to disk in this
 * module's database (the audit log records tool-call metadata, not data).
 */

import { createIntegrationClient } from "./holaboss-bridge"
import type { Result, ZoomInfoError } from "../lib/types"

const ZOOMINFO_BASE = "https://api.zoominfo.com"

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
  return createIntegrationClient("zoominfo") as BridgeLike
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
    msg.includes("no zoominfo integration") ||
    msg.includes("not connected") ||
    msg.includes("not_connected") ||
    msg.includes("connect via integrations")
  )
}

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

export async function call<T>(
  method: HttpMethod,
  endpoint: string,
  body?: unknown,
): Promise<Result<T, ZoomInfoError>> {
  const client = getBridgeClient()
  let resp
  try {
    resp = await client.proxy<T>({
      method,
      endpoint: `${ZOOMINFO_BASE}${endpoint}`,
      body,
    })
  } catch (e) {
    if (isNotConnectedError(e)) {
      return {
        ok: false,
        error: {
          code: "not_connected",
          message: "ZoomInfo is not connected for this workspace.",
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
        message: extractErrorMessage(resp.data) ?? "ZoomInfo credential rejected by API.",
      },
    }
  }
  if (resp.status === 404) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: extractErrorMessage(resp.data) ?? "ZoomInfo returned 404.",
      },
    }
  }
  if (resp.status === 429) {
    return {
      ok: false,
      error: {
        code: "rate_limited",
        message: "ZoomInfo API rate limit exceeded.",
        retry_after: parseRetryAfter(resp.headers),
      },
    }
  }
  if (resp.status >= 400 && resp.status < 500) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: extractErrorMessage(resp.data) ?? `ZoomInfo returned HTTP ${resp.status}.`,
      },
    }
  }
  return {
    ok: false,
    error: {
      code: "upstream_error",
      message: extractErrorMessage(resp.data) ?? `ZoomInfo returned HTTP ${resp.status}.`,
    },
  }
}

export const apiGet = <T>(endpoint: string) => call<T>("GET", endpoint)
export const apiPost = <T>(endpoint: string, body: unknown) => call<T>("POST", endpoint, body)
