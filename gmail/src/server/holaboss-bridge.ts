/**
 * Holaboss Bridge SDK (minimal, module-local)
 *
 * Apps never receive raw provider tokens. All provider API calls go through
 * the Holaboss runtime broker proxy, which injects credentials server-side.
 *
 * Usage:
 *   const google = createIntegrationClient("google")
 *   const profile = await google.proxy({ method: "GET", path: "/gmail/v1/users/me/profile" })
 */

const APP_GRANT = process.env.HOLABOSS_APP_GRANT ?? ""

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
        // ignore
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

export interface ProxyRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Full provider URL, e.g. "https://gmail.googleapis.com/gmail/v1/users/me/profile" */
  endpoint: string
  body?: unknown
}

export interface ProxyResponse<T = unknown> {
  data: T | null
  status: number
  headers: Record<string, string>
}

export interface IntegrationClient {
  proxy<T = unknown>(request: ProxyRequest): Promise<ProxyResponse<T>>
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
            ...(request.body !== undefined ? { body: request.body } : {})
          }
        })
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Bridge proxy error (${response.status}): ${text.slice(0, 500)}`)
      }

      return (await response.json()) as ProxyResponse<T>
    }
  }
}
