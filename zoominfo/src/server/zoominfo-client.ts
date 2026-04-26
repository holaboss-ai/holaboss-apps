/**
 * ZoomInfo API client.
 *
 * Auth Path B (per docs/plans/zoominfo.md §10 open question):
 *   - JWT is fetched lazily and cached in-process for ~50 minutes.
 *   - On 401 from the data API, the cache is evicted and the request retries
 *     once with a fresh JWT.
 *   - Credentials are fetched from the Holaboss bridge each time we need a
 *     new JWT — they may be (username + password) or (username + clientId +
 *     privateKey) depending on the workspace's connector.
 *
 * The JWT cache is in-process only (`let cachedJwt: ...`) and never persisted
 * to disk. This is required by the ZoomInfo license terms — see plan §3 and §10.
 */

import { MODULE_CONFIG } from "../lib/types"
import type { Result, ZoomInfoError } from "../lib/types"

const ZOOMINFO_BASE = "https://api.zoominfo.com"
const JWT_TTL_MS = 50 * 60 * 1000 // 50-minute safety margin under the 60-minute token TTL

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE"

export interface BridgeLike {
  /**
   * Returns the workspace's ZoomInfo credential payload as opaque JSON.
   * Possible shapes (tested in the Impl):
   *   - { username: string, password: string }
   *   - { username: string, clientId: string, privateKey: string }
   *   - { jwt: string }                               // pre-minted by Nango
   *   - { access_token: string }                      // alternate alias for jwt
   */
  getCredential: (provider: string) => Promise<Record<string, unknown>>
}

let _client: BridgeLike | null = null

function defaultClient(): BridgeLike {
  return {
    async getCredential(provider: string): Promise<Record<string, unknown>> {
      const broker = process.env.HOLABOSS_INTEGRATION_BROKER_URL
      const grant = process.env.HOLABOSS_APP_GRANT
      if (!broker || !grant) {
        throw new Error(`No ${provider} integration configured. Connect via Integrations settings.`)
      }
      const r = await fetch(`${broker}/broker/credential`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant, provider }),
      })
      if (!r.ok) {
        const text = await r.text()
        throw new Error(`Bridge credential fetch error (${r.status}): ${text.slice(0, 500)}`)
      }
      return (await r.json()) as Record<string, unknown>
    },
  }
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

interface CachedJwt {
  token: string
  expiresAt: number
}

let cachedJwt: CachedJwt | null = null

export function resetJwtCache(): void {
  cachedJwt = null
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

/**
 * Mint or reuse a JWT for the next request.
 * Surfaces the network/credential errors as thrown Errors — `call(...)` maps
 * them into the Result envelope.
 */
export async function getJwt(): Promise<string> {
  if (cachedJwt && Date.now() < cachedJwt.expiresAt) return cachedJwt.token
  const creds = await getBridgeClient().getCredential(MODULE_CONFIG.destination)

  // If Nango already minted a JWT for us, use it directly (still cache for 50 min).
  const preMinted = pickString(creds, "jwt") ?? pickString(creds, "access_token")
  if (preMinted) {
    cachedJwt = { token: preMinted, expiresAt: Date.now() + JWT_TTL_MS }
    return preMinted
  }

  const username = pickString(creds, "username")
  const password = pickString(creds, "password")
  const clientId = pickString(creds, "clientId") ?? pickString(creds, "client_id")
  const privateKey = pickString(creds, "privateKey") ?? pickString(creds, "private_key")

  // Path B exchange: POST /authenticate with either (username, password) or
  // (username, clientId, privateKey). Verified against
  // https://api-docs.zoominfo.com/ — see Phase 0 in the agent task.
  let body: Record<string, string>
  if (username && password) {
    body = { username, password }
  } else if (username && clientId && privateKey) {
    body = { username, clientId, privateKey }
  } else {
    throw new Error("not_connected")
  }

  const r = await fetch(`${ZOOMINFO_BASE}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => "")
    if (r.status === 401 || r.status === 403) {
      throw new Error("not_connected")
    }
    throw new Error(`ZoomInfo authenticate failed (${r.status}): ${text.slice(0, 300)}`)
  }
  const json = (await r.json()) as { jwt?: string; access_token?: string }
  const token = json.jwt ?? json.access_token
  if (!token) {
    throw new Error("ZoomInfo authenticate response missing jwt field")
  }
  cachedJwt = { token, expiresAt: Date.now() + JWT_TTL_MS }
  return token
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")
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

interface RawResponse {
  status: number
  headers: Headers
  data: unknown
}

async function rawFetch(method: HttpMethod, endpoint: string, body: unknown, jwt: string): Promise<RawResponse> {
  const r = await fetch(`${ZOOMINFO_BASE}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data: unknown = null
  const text = await r.text()
  if (text.length > 0) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  return { status: r.status, headers: r.headers, data }
}

export async function call<T>(
  method: HttpMethod,
  endpoint: string,
  body?: unknown,
): Promise<Result<T, ZoomInfoError>> {
  let jwt: string
  try {
    jwt = await getJwt()
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

  let resp: RawResponse
  try {
    resp = await rawFetch(method, endpoint, body, jwt)
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "upstream_error",
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }

  // 401 → evict cache and retry once with a fresh JWT.
  if (resp.status === 401) {
    resetJwtCache()
    try {
      jwt = await getJwt()
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
    try {
      resp = await rawFetch(method, endpoint, body, jwt)
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "upstream_error",
          message: e instanceof Error ? e.message : String(e),
        },
      }
    }
    // Still unauthorized after re-auth → treat as not_connected.
    if (resp.status === 401 || resp.status === 403) {
      resetJwtCache()
      return {
        ok: false,
        error: {
          code: "not_connected",
          message: "ZoomInfo credential rejected by API.",
        },
      }
    }
  }

  if (resp.status >= 200 && resp.status < 300) {
    return { ok: true, data: resp.data as T }
  }
  if (resp.status === 403) {
    resetJwtCache()
    return {
      ok: false,
      error: {
        code: "not_connected",
        message: extractErrorMessage(resp.data) ?? "ZoomInfo credential lacks permission for this endpoint.",
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
