import { apiGet } from "./hubspot-client"

export interface ConnectionStatus {
  connected: boolean
  portal_id?: string
  scopes?: string[]
  error?: string
}

interface AccountDetails {
  portalId?: number
  accountType?: string
  uiDomain?: string
}

/**
 * Verify the bridge has a usable token and report portal id.
 *
 * Source endpoint per Phase 0: `/account-info/v3/details` returns
 * `{ portalId, accountType, uiDomain, ... }` using just the Bearer token
 * (the OAuth introspect endpoint requires a client_secret we don't hold).
 *
 * Scopes are NOT exposed by /account-info; they're returned at OAuth grant
 * time and cached by the bridge. We surface only `connected` + `portal_id`
 * here; if we later add a scopes-fetch path we can extend this.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const r = await apiGet<AccountDetails>("/account-info/v3/details")
  if (r.ok) {
    return {
      connected: true,
      portal_id: r.data?.portalId !== undefined ? String(r.data.portalId) : undefined,
    }
  }
  if (r.error.code === "not_connected") {
    return { connected: false }
  }
  return { connected: false, error: r.error.message }
}
