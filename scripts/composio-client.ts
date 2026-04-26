/**
 * Minimal Composio client primitives for the dev broker + connect CLI.
 *
 * NOT a published package — this lives next to the dev broker because the
 * broker is the only consumer. If a third place needs Composio access,
 * extract this into a shared package.
 *
 * The shapes mirror @composio's REST API at https://backend.composio.dev.
 */

const DEFAULT_BASE_URL = "https://backend.composio.dev"

export interface ManagedConnectLinkResult {
  authConfigId: string
  authConfigCreated: boolean
  connectedAccountId: string
  redirectUrl: string
  expiresAt: string | null
  userId: string
}

export interface ConnectedAccount {
  id: string
  status: string
  authConfigId: string | null
  toolkitSlug: string | null
  userId: string | null
}

export interface ProxyProviderResponse<T = unknown> {
  data: T | null
  status: number
  headers: Record<string, string>
}

interface AuthConfigItem {
  id?: string
  status?: string
  is_composio_managed?: boolean
  toolkit?: { slug?: string | null } | null
}

function required(value: string, name: string): string {
  const t = value.trim()
  if (!t) throw new Error(`${name} is required`)
  return t
}

function headers(apiKey: string): Record<string, string> {
  return {
    "x-api-key": required(apiKey, "apiKey"),
    "Content-Type": "application/json",
    Accept: "application/json",
  }
}

function trimBase(base?: string): string {
  return (base?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "")
}

async function readBody(r: Response): Promise<string> {
  const text = await r.text()
  if (!r.ok) throw new Error(`Composio ${r.status}: ${text.slice(0, 500)}`)
  return text
}

/** Sentinel error thrown when Composio doesn't have managed auth for a toolkit. */
export class ManagedAuthNotAvailableError extends Error {
  readonly toolkitSlug: string
  constructor(toolkitSlug: string, raw: string) {
    super(
      `Composio does not have managed auth for "${toolkitSlug}". ` +
        `Pass custom credentials (api_key for API-key toolkits, client_id+client_secret for OAuth). ` +
        `Original Composio response: ${raw.slice(0, 300)}`,
    )
    this.toolkitSlug = toolkitSlug
    this.name = "ManagedAuthNotAvailableError"
  }
}

function isManagedNotAvailable(raw: string): boolean {
  // Composio surfaces this with code 306 / slug Auth_Config_DefaultAuthConfigNotFound.
  return /Auth_Config_DefaultAuthConfigNotFound/i.test(raw) ||
    /Default auth config not found for toolkit/i.test(raw)
}

async function listAuthConfigs(
  apiKey: string,
  toolkitSlug: string,
  baseUrl?: string,
): Promise<AuthConfigItem[]> {
  // List ALL auth configs for the toolkit (managed + custom). Filtering happens client-side.
  const q = new URLSearchParams({ toolkit_slug: toolkitSlug, show_disabled: "false" })
  const r = await fetch(`${trimBase(baseUrl)}/api/v3/auth_configs?${q.toString()}`, {
    headers: headers(apiKey),
  })
  const text = await readBody(r)
  const payload = JSON.parse(text) as { items?: AuthConfigItem[] }
  return payload.items ?? []
}

async function createAuthConfig(
  apiKey: string,
  toolkitSlug: string,
  customCredentials: Record<string, unknown> | undefined,
  baseUrl?: string,
): Promise<string> {
  const authConfig = customCredentials
    ? { type: "use_custom_auth" as const, credentials: customCredentials }
    : { type: "use_composio_managed_auth" as const }

  const r = await fetch(`${trimBase(baseUrl)}/api/v3/auth_configs`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ toolkit: { slug: toolkitSlug }, auth_config: authConfig }),
  })
  if (!r.ok) {
    const text = await r.text()
    if (!customCredentials && isManagedNotAvailable(text)) {
      throw new ManagedAuthNotAvailableError(toolkitSlug, text)
    }
    throw new Error(`Composio ${r.status}: ${text.slice(0, 500)}`)
  }
  const text = await r.text()
  const payload = JSON.parse(text) as { id?: string; auth_config?: { id?: string } }
  return required(payload.id ?? payload.auth_config?.id ?? "", "authConfigId")
}

/**
 * Bootstrap a Composio connect link. Tries this order:
 *   1. Reuse the first ENABLED auth_config for the toolkit (managed or custom).
 *   2. Otherwise create a new auth_config:
 *      - If `customCredentials` provided → `use_custom_auth` with those creds.
 *      - Else → `use_composio_managed_auth`. If Composio doesn't have managed
 *        auth for this toolkit, throws `ManagedAuthNotAvailableError`.
 *
 * customCredentials shape is toolkit-dependent. Common shapes:
 *   - API-key toolkits (apollo, instantly):  { api_key: "..." }
 *   - OAuth toolkits (hubspot when not managed):  { client_id, client_secret }
 *   - ZoomInfo:  { username, password }  OR  { username, clientId, privateKey }
 */
export async function createManagedConnectLink(params: {
  apiKey: string
  toolkitSlug: string
  userId: string
  callbackUrl?: string
  baseUrl?: string
  customCredentials?: Record<string, unknown>
}): Promise<ManagedConnectLinkResult> {
  const toolkitSlug = required(params.toolkitSlug, "toolkitSlug")
  const userId = required(params.userId, "userId")
  const configs = await listAuthConfigs(params.apiKey, toolkitSlug, params.baseUrl)
  const existing = configs.find(
    (c) =>
      c.status?.toUpperCase() === "ENABLED" &&
      c.toolkit?.slug?.toLowerCase() === toolkitSlug.toLowerCase(),
  )
  const authConfigId =
    existing?.id ??
    (await createAuthConfig(params.apiKey, toolkitSlug, params.customCredentials, params.baseUrl))

  const r = await fetch(`${trimBase(params.baseUrl)}/api/v3/connected_accounts/link`, {
    method: "POST",
    headers: headers(params.apiKey),
    body: JSON.stringify({
      auth_config_id: authConfigId,
      user_id: userId,
      ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
    }),
  })
  const text = await readBody(r)
  const payload = JSON.parse(text) as {
    redirect_url?: string
    expires_at?: string | null
    connected_account_id?: string
  }
  return {
    authConfigId,
    authConfigCreated: !existing,
    connectedAccountId: required(payload.connected_account_id ?? "", "connectedAccountId"),
    redirectUrl: required(payload.redirect_url ?? "", "redirectUrl"),
    expiresAt: payload.expires_at ?? null,
    userId,
  }
}

export async function getConnectedAccount(params: {
  apiKey: string
  connectedAccountId: string
  baseUrl?: string
}): Promise<ConnectedAccount> {
  const id = required(params.connectedAccountId, "connectedAccountId")
  const r = await fetch(`${trimBase(params.baseUrl)}/api/v3/connected_accounts/${id}`, {
    headers: headers(params.apiKey),
  })
  const text = await readBody(r)
  const payload = JSON.parse(text) as {
    id?: string
    status?: string
    auth_config?: { id?: string } | null
    toolkit?: { slug?: string } | null
    user_id?: string
  }
  return {
    id: payload.id ?? id,
    status: (payload.status ?? "unknown").toUpperCase(),
    authConfigId: payload.auth_config?.id ?? null,
    toolkitSlug: payload.toolkit?.slug ?? null,
    userId: payload.user_id ?? null,
  }
}

export async function waitForConnectedAccount(params: {
  apiKey: string
  connectedAccountId: string
  baseUrl?: string
  timeoutMs?: number
  intervalMs?: number
  onTick?: (status: string) => void
}): Promise<ConnectedAccount> {
  const timeoutMs = params.timeoutMs ?? 300_000
  const intervalMs = params.intervalMs ?? 3_000
  const deadline = Date.now() + timeoutMs

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const account = await getConnectedAccount(params)
    params.onTick?.(account.status)
    if (account.status === "ACTIVE") return account
    if (Date.now() + intervalMs > deadline) {
      throw new Error(
        `Connected account ${params.connectedAccountId} did not become ACTIVE within ${timeoutMs}ms (last status: ${account.status})`,
      )
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export async function proxyProviderRequest<T = unknown>(params: {
  apiKey: string
  connectedAccountId: string
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  endpoint: string
  body?: unknown
  baseUrl?: string
}): Promise<ProxyProviderResponse<T>> {
  const r = await fetch(`${trimBase(params.baseUrl)}/api/v3/tools/execute/proxy`, {
    method: "POST",
    headers: headers(params.apiKey),
    body: JSON.stringify({
      connected_account_id: required(params.connectedAccountId, "connectedAccountId"),
      endpoint: required(params.endpoint, "endpoint"),
      method: params.method,
      ...(params.body !== undefined ? { body: params.body } : {}),
    }),
  })
  const text = await readBody(r)
  const payload = JSON.parse(text) as {
    data?: T | null
    status?: number
    headers?: Record<string, string>
  }
  return {
    data: payload.data ?? null,
    status: payload.status ?? r.status,
    headers: payload.headers ?? {},
  }
}
