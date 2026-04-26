import { apiGet } from "./zoominfo-client"

export interface ConnectionStatus {
  connected: boolean
  error?: string
}

/**
 * Probes ZoomInfo through the broker proxy with a cheap metadata call.
 * Per plan §3, `GET /lookup/inputfields/contact/search` is lightweight and
 * does not consume credits. If the broker doesn't have a credential for
 * this workspace it surfaces as `not_connected`; any 2xx → connected.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const r = await apiGet<unknown>("/lookup/inputfields/contact/search")
  if (r.ok) return { connected: true }
  if (r.error.code === "not_connected") return { connected: false }
  return { connected: false, error: r.error.message }
}
