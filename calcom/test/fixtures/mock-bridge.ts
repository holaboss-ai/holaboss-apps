export interface ProxyRequestLike {
  method: string
  endpoint: string
  body?: unknown
}

export interface ProxyResponseLike<T = unknown> {
  data: T | null
  status: number
  headers: Record<string, string>
}

type Responder = (req: ProxyRequestLike) => ProxyResponseLike | Promise<ProxyResponseLike> | { throw: Error }

type Rule = {
  method?: string
  matchEndpoint?: (endpoint: string) => boolean
  once: boolean
  consumed: boolean
  respond: Responder
}

export class MockBridge {
  private rules: Rule[] = []
  public calls: ProxyRequestLike[] = []

  reset() {
    this.rules = []
    this.calls = []
  }

  whenGet(suffix: string) { return this.matcher("GET", (e) => e.includes(suffix)) }
  whenPost(suffix: string) { return this.matcher("POST", (e) => e.includes(suffix)) }
  whenPatch(suffix: string) { return this.matcher("PATCH", (e) => e.includes(suffix)) }
  whenDelete(suffix: string) { return this.matcher("DELETE", (e) => e.includes(suffix)) }
  whenAny() { return this.matcher(undefined, () => true) }

  private matcher(method: string | undefined, matchEndpoint: (e: string) => boolean) {
    const self = this
    return {
      respond(status: number, data: unknown = {}, headers: Record<string, string> = {}) {
        self.rules.push({ method, matchEndpoint, once: false, consumed: false, respond: () => ({ data, status, headers }) })
        return self
      },
      respondOnce(status: number, data: unknown = {}, headers: Record<string, string> = {}) {
        self.rules.push({ method, matchEndpoint, once: true, consumed: false, respond: () => ({ data, status, headers }) })
        return self
      },
      throwOnce(error: Error) {
        self.rules.push({ method, matchEndpoint, once: true, consumed: false, respond: () => ({ throw: error }) })
        return self
      },
    }
  }

  async proxy<T>(req: ProxyRequestLike): Promise<ProxyResponseLike<T>> {
    this.calls.push(req)
    for (const rule of this.rules) {
      if (rule.consumed) continue
      if (rule.method && rule.method !== req.method) continue
      if (rule.matchEndpoint && !rule.matchEndpoint(req.endpoint)) continue
      if (rule.once) rule.consumed = true
      const out = await rule.respond(req)
      if ("throw" in out) throw out.throw
      return out as ProxyResponseLike<T>
    }
    throw new Error(`mock-bridge: no rule matched ${req.method} ${req.endpoint}`)
  }

  asClient() {
    return { proxy: this.proxy.bind(this) }
  }
}