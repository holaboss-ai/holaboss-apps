/**
 * Test fixture for the ZoomInfo client.
 *
 * The client makes two kinds of outbound calls:
 *   1. `getBridgeClient().getCredential("zoominfo")` — fetches the workspace's
 *      credential payload (we mock by returning a plain object).
 *   2. `fetch(...)` against `https://api.zoominfo.com/...` — the data plane.
 *
 * MockBridge owns both: it implements the `BridgeLike` interface (for #1) and
 * installs a `globalThis.fetch` shim (for #2) that matches against registered
 * rules.
 */

interface ProxyResponseLike<T = unknown> {
  data: T | null
  status: number
  headers: Record<string, string>
}

type Responder = () => ProxyResponseLike | Promise<ProxyResponseLike>

interface Rule {
  method: string
  matchEndpoint: (endpoint: string) => boolean
  once: boolean
  consumed: boolean
  respond: Responder
}

const ZOOMINFO_BASE = "https://api.zoominfo.com"

let originalFetch: typeof globalThis.fetch | null = null

export class MockBridge {
  private rules: Array<Rule> = []
  private credentialResponder: () => Promise<Record<string, unknown>> = async () => ({
    username: "u",
    password: "p",
  })
  public calls: Array<{ method: string; endpoint: string; body?: unknown }> = []

  reset() {
    this.rules = []
    this.calls = []
  }

  /** Provide a custom credential payload (default: {username:'u',password:'p'}). */
  setCredentialPayload(payload: Record<string, unknown>) {
    this.credentialResponder = async () => payload
    return this
  }

  /** Make `getCredential` throw (simulates "not connected" from broker). */
  failGetCredential(err: Error) {
    this.credentialResponder = async () => {
      throw err
    }
    return this
  }

  whenAuthenticate() {
    return this.matcher("POST", (e) => e === "/authenticate")
  }
  whenPost(endpointPath: string) {
    return this.matcher("POST", (e) => e === endpointPath)
  }
  whenGet(endpointPath: string) {
    return this.matcher("GET", (e) => e === endpointPath)
  }

  private matcher(method: string, matchEndpoint: (e: string) => boolean) {
    const self = this
    return {
      respond(statusOrBody: number | Record<string, unknown>, maybeBody?: unknown, headers: Record<string, string> = {}) {
        const status = typeof statusOrBody === "number" ? statusOrBody : 200
        const body = typeof statusOrBody === "number" ? maybeBody : statusOrBody
        self.rules.push({
          method,
          matchEndpoint,
          once: false,
          consumed: false,
          respond: () => ({ data: body ?? {}, status, headers }),
        })
        return self
      },
      respondOnce(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
        self.rules.push({
          method,
          matchEndpoint,
          once: true,
          consumed: false,
          respond: () => ({ data: body, status, headers }),
        })
        return self
      },
    }
  }

  private async match(method: string, endpoint: string): Promise<ProxyResponseLike> {
    for (const rule of this.rules) {
      if (rule.consumed) continue
      if (rule.method !== method) continue
      if (!rule.matchEndpoint(endpoint)) continue
      if (rule.once) rule.consumed = true
      return await rule.respond()
    }
    throw new Error(`mock-bridge: no rule matched ${method} ${endpoint}`)
  }

  /**
   * Install a global fetch mock that intercepts any request whose URL starts
   * with the ZoomInfo base. Other requests pass through to the original
   * fetch (necessary for the e2e test's `/mcp/health` probe).
   */
  useGlobalFetchMock() {
    if (!originalFetch) originalFetch = globalThis.fetch
    const self = this
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith(ZOOMINFO_BASE)) {
        return originalFetch!(input, init)
      }
      const endpoint = url.slice(ZOOMINFO_BASE.length)
      const method = (init?.method ?? "GET").toUpperCase()
      let body: unknown
      if (init?.body) {
        try {
          body = JSON.parse(String(init.body))
        } catch {
          body = init.body
        }
      }
      self.calls.push({ method, endpoint, body })
      const resp = await self.match(method, endpoint)
      const text = resp.data === null ? "" : JSON.stringify(resp.data)
      const headers = new Headers(resp.headers)
      return new Response(text, { status: resp.status, headers })
    })
    return this
  }

  static restoreGlobalFetch() {
    if (originalFetch) {
      globalThis.fetch = originalFetch
      originalFetch = null
    }
  }

  asClient() {
    const self = this
    return {
      async getCredential(_provider: string): Promise<Record<string, unknown>> {
        return self.credentialResponder()
      },
    }
  }
}
