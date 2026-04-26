import { apiGet } from "./apollo-client"

export interface ConnectionStatus {
  connected: boolean
  user_email?: string
  team_name?: string
  is_master_key?: boolean
  error?: string
}

interface AuthHealthResponse {
  is_logged_in: boolean
  is_master_key?: boolean
  user?: { email?: string }
  team?: { name?: string }
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const r = await apiGet<AuthHealthResponse>("/auth/health")
  if (r.ok) {
    return {
      connected: Boolean(r.data?.is_logged_in ?? true),
      user_email: r.data?.user?.email,
      team_name: r.data?.team?.name,
      is_master_key: r.data?.is_master_key,
    }
  }
  if (r.error.code === "not_connected") {
    return { connected: false }
  }
  return { connected: false, error: r.error.message }
}
