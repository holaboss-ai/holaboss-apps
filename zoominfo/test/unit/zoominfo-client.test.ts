import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { call, getJwt, resetJwtCache, setBridgeClient } from "../../src/server/zoominfo-client"
import { MockBridge } from "../fixtures/mock-bridge"

describe("zoominfo-client.getJwt", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
    resetJwtCache()
    bridge.useGlobalFetchMock()
  })

  afterEach(() => {
    MockBridge.restoreGlobalFetch()
    setBridgeClient(null)
  })

  it("mints a JWT via /authenticate on first call (username+password)", async () => {
    bridge.setCredentialPayload({ username: "u", password: "p" })
    bridge.whenAuthenticate().respond({ jwt: "mint-1" })
    const token = await getJwt()
    expect(token).toBe("mint-1")
    const authCalls = bridge.calls.filter((c) => c.endpoint === "/authenticate")
    expect(authCalls).toHaveLength(1)
    expect(authCalls[0].body).toMatchObject({ username: "u", password: "p" })
  })

  it("mints a JWT via /authenticate on first call (PKI shape)", async () => {
    bridge.setCredentialPayload({ username: "u", clientId: "cid", privateKey: "pk" })
    bridge.whenAuthenticate().respond({ jwt: "mint-pki" })
    const token = await getJwt()
    expect(token).toBe("mint-pki")
    const authCall = bridge.calls.find((c) => c.endpoint === "/authenticate")
    expect(authCall!.body).toMatchObject({ username: "u", clientId: "cid", privateKey: "pk" })
  })

  it("returns the cached token on subsequent calls (cache hit)", async () => {
    bridge.setCredentialPayload({ username: "u", password: "p" })
    bridge.whenAuthenticate().respond({ jwt: "cached" })
    const a = await getJwt()
    const b = await getJwt()
    const c = await getJwt()
    expect(a).toBe("cached")
    expect(b).toBe("cached")
    expect(c).toBe("cached")
    expect(bridge.calls.filter((x) => x.endpoint === "/authenticate")).toHaveLength(1)
  })

  it("uses pre-minted JWT directly when bridge returns one", async () => {
    bridge.setCredentialPayload({ jwt: "pre-minted-from-nango" })
    const token = await getJwt()
    expect(token).toBe("pre-minted-from-nango")
    // No /authenticate call because we already had a JWT.
    expect(bridge.calls.filter((c) => c.endpoint === "/authenticate")).toHaveLength(0)
  })

  it("throws not_connected if credential payload is empty", async () => {
    bridge.setCredentialPayload({})
    await expect(getJwt()).rejects.toThrow(/not_connected/)
  })
})

describe("zoominfo-client.call", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    bridge.setCredentialPayload({ jwt: "test-jwt" })
    setBridgeClient(bridge.asClient())
    resetJwtCache()
    bridge.useGlobalFetchMock()
  })

  afterEach(() => {
    MockBridge.restoreGlobalFetch()
    setBridgeClient(null)
  })

  it("returns ok for 2xx", async () => {
    bridge.whenPost("/search/contact").respond(200, { data: [{ id: "p_1" }] })
    const r = await call<{ data: Array<{ id: string }> }>("POST", "/search/contact", { rpp: 25 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.data[0].id).toBe("p_1")
  })

  it("maps 400 to validation_failed with body message", async () => {
    bridge.whenPost("/search/contact").respond(400, { message: "Invalid jobTitle" })
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("Invalid")
    }
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge.whenPost("/search/contact").respond(429, { error: "slow down" }, { "retry-after": "30" })
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(30)
    }
  })

  it("on 401, evicts cache, re-auths, and retries once", async () => {
    bridge.setCredentialPayload({ username: "u", password: "p" })
    // First: mint old JWT.
    bridge.whenAuthenticate().respondOnce(200, { jwt: "old-jwt" })
    // Data API call: 401 once, then 200.
    bridge.whenPost("/search/contact").respondOnce(401, { error: "expired" })
    bridge.whenPost("/search/contact").respondOnce(200, { data: [{ id: "after-refresh" }] })
    // Re-auth call: mint new JWT.
    bridge.whenAuthenticate().respondOnce(200, { jwt: "new-jwt" })

    const r = await call<{ data: Array<{ id: string }> }>("POST", "/search/contact", {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.data[0].id).toBe("after-refresh")

    const authCalls = bridge.calls.filter((c) => c.endpoint === "/authenticate")
    expect(authCalls).toHaveLength(2)
  })

  it("maps 500 to upstream_error", async () => {
    bridge.whenPost("/search/contact").respond(503, { error: "boom" })
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps a credential broker failure to not_connected", async () => {
    bridge.failGetCredential(new Error("No zoominfo integration configured. Connect via Integrations settings."))
    resetJwtCache()
    const r = await call("POST", "/search/contact", {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })
})
