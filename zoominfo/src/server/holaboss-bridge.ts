/**
 * Holaboss Bridge SDK (module-local)
 *
 * Provider API calls go through the Holaboss broker proxy. Workspace outputs
 * are written back through the local workspace API when the module is running
 * inside a Holaboss workspace.
 */

const APP_GRANT = process.env.HOLABOSS_APP_GRANT ?? ""
const WORKSPACE_ID = process.env.HOLABOSS_WORKSPACE_ID ?? ""

function resolveBrokerUrl(): string {
  const explicit = process.env.HOLABOSS_INTEGRATION_BROKER_URL ?? ""
  if (explicit) {
    const runtimePort = process.env.SANDBOX_RUNTIME_API_PORT ?? process.env.SANDBOX_AGENT_BIND_PORT ?? ""
    if (runtimePort) {
      try {
        const url = new URL(explicit)
        if (url.port !== runtimePort) {
          url.port = runtimePort
          return url.toString().replace(/\/$/, "")
        }
      } catch {
        // ignore malformed explicit URL
      }
    }
    return explicit
  }

  const port = process.env.SANDBOX_RUNTIME_API_PORT ?? process.env.SANDBOX_AGENT_BIND_PORT ?? process.env.PORT ?? ""
  if (port) {
    return `http://127.0.0.1:${port}/api/v1/integrations`
  }
  return ""
}

function resolveWorkspaceApiUrl(): string {
  const explicit = process.env.WORKSPACE_API_URL ?? ""
  if (explicit) {
    return explicit.replace(/\/$/, "")
  }
  const brokerUrl = resolveBrokerUrl()
  if (!brokerUrl) {
    return ""
  }
  return brokerUrl.replace(/\/integrations$/, "")
}

function canPublishAppOutputs(): boolean {
  return Boolean(resolveWorkspaceApiUrl() && WORKSPACE_ID.trim())
}

export interface ProxyRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  endpoint: string
  body?: unknown
}

export interface ProxyResponse<T = unknown> {
  data: T | null
  status: number
  headers: Record<string, string>
}

export interface IntegrationClient {
  proxy: <T = unknown>(request: ProxyRequest) => Promise<ProxyResponse<T>>
}

export interface AppOutputPresentationInput {
  view: string
  path: string
}

export interface WorkspaceOutputPayload {
  id: string
  workspace_id: string
  output_type: string
  title: string
  status: string
  module_id: string | null
  module_resource_id: string | null
  file_path: string | null
  html_content: string | null
  session_id: string | null
  artifact_id: string | null
  folder_id: string | null
  platform: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

interface WorkspaceOutputResponsePayload {
  output: WorkspaceOutputPayload
}

export interface CreateAppOutputRequest {
  outputType: string
  title: string
  moduleId: string
  moduleResourceId?: string | null
  platform?: string | null
  status?: string | null
  metadata?: Record<string, unknown> | null
}

export interface UpdateAppOutputRequest {
  title?: string | null
  status?: string | null
  moduleResourceId?: string | null
  metadata?: Record<string, unknown> | null
}

export function buildAppResourcePresentation({ view, path }: AppOutputPresentationInput) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return {
    kind: "app_resource",
    view,
    path: normalizedPath,
  }
}

export function createIntegrationClient(provider: string): IntegrationClient {
  const brokerUrl = resolveBrokerUrl()

  return {
    async proxy<T = unknown>(request: ProxyRequest): Promise<ProxyResponse<T>> {
      if (!brokerUrl || !APP_GRANT) {
        throw new Error(`No ${provider} integration configured. Connect via Integrations settings.`)
      }

      const response = await fetch(`${brokerUrl}/broker/proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant: APP_GRANT,
          provider,
          request: {
            method: request.method,
            endpoint: request.endpoint,
            ...(request.body !== undefined ? { body: request.body } : {}),
          },
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Bridge proxy error (${response.status}): ${text.slice(0, 500)}`)
      }

      return (await response.json()) as ProxyResponse<T>
    },
  }
}

export async function createAppOutput(
  request: CreateAppOutputRequest,
): Promise<WorkspaceOutputPayload | null> {
  if (!canPublishAppOutputs()) {
    return null
  }

  const response = await fetch(`${resolveWorkspaceApiUrl()}/outputs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-holaboss-workspace-id": WORKSPACE_ID,
    },
    body: JSON.stringify({
      workspace_id: WORKSPACE_ID,
      output_type: request.outputType,
      title: request.title,
      module_id: request.moduleId,
      module_resource_id: request.moduleResourceId ?? null,
      platform: request.platform ?? null,
      metadata: request.metadata ?? {},
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Workspace output create failed (${response.status}): ${text.slice(0, 500)}`)
  }

  const created = ((await response.json()) as WorkspaceOutputResponsePayload).output
  if (request.status && request.status.trim() && request.status.trim().toLowerCase() !== "draft") {
    return updateAppOutput(created.id, {
      title: request.title,
      status: request.status,
      moduleResourceId: request.moduleResourceId ?? null,
      metadata: request.metadata ?? {},
    })
  }

  return created
}

export async function updateAppOutput(
  outputId: string,
  request: UpdateAppOutputRequest,
): Promise<WorkspaceOutputPayload | null> {
  if (!canPublishAppOutputs()) {
    return null
  }

  const response = await fetch(`${resolveWorkspaceApiUrl()}/outputs/${encodeURIComponent(outputId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-holaboss-workspace-id": WORKSPACE_ID,
    },
    body: JSON.stringify({
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.status !== undefined ? { status: request.status } : {}),
      ...(request.moduleResourceId !== undefined ? { module_resource_id: request.moduleResourceId } : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Workspace output update failed (${response.status}): ${text.slice(0, 500)}`)
  }

  return ((await response.json()) as WorkspaceOutputResponsePayload).output
}
