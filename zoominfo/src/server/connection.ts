import { getJwt } from "./zoominfo-client"

export interface ConnectionStatus {
  connected: boolean
  error?: string
}

/**
 * The cheapest connection check is a successful auth handshake.
 * `getJwt()` either returns a cached token (no network) or hits
 * `POST /authenticate` and caches the result for 50 minutes.
 *
 * Note: ZoomInfo's API does not expose `daily_quota_remaining` per the
 * Phase 0 endpoint review (no public Usage endpoint we can hit without
 * additional credentials), so it is omitted from the status payload.
 * See docs/plans/zoominfo.md §10 open question.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  try {
    await getJwt()
    return { connected: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes("not connected") || msg === "not_connected") {
      return { connected: false }
    }
    return { connected: false, error: msg }
  }
}
