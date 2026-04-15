import { apiGet } from "./attio-client"

export interface ConnectionStatus {
  connected: boolean
  workspace_name?: string
  error?: string
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const r = await apiGet<{ data: { workspace_name?: string } }>("/self")
  if (r.ok) {
    return { connected: true, workspace_name: r.data.data?.workspace_name }
  }
  if (r.error.code === "not_connected") {
    return { connected: false }
  }
  return { connected: false, error: r.error.message }
}