import { apiGet } from "./calcom-client"

export interface ConnectionStatus {
  connected: boolean
  event_types_count?: number
  error?: string
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>("/event-types")
  if (r.ok) {
    return {
      connected: true,
      event_types_count: (r.data.data ?? []).length,
    }
  }
  if (r.error.code === "not_connected") {
    return { connected: false }
  }
  return { connected: false, error: r.error.message }
}