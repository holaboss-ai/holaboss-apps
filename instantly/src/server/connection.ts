import { apiGet } from "./instantly-client"

export interface ConnectionStatus {
  connected: boolean
  workspace_name?: string
  error?: string
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  // Instantly v2: GET /workspaces/current returns the active workspace.
  const r = await apiGet<{ name?: string; workspace_name?: string }>("/workspaces/current")
  if (r.ok) {
    const name = r.data?.name ?? r.data?.workspace_name
    return { connected: true, workspace_name: name }
  }
  if (r.error.code === "not_connected") {
    return { connected: false }
  }
  return { connected: false, error: r.error.message }
}
