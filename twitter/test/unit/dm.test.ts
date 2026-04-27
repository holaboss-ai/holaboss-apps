import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  listDirectMessages,
  listRecentDmEvents,
  resetBridgeClient,
  sendDirectMessage,
  setBridgeClient,
} from "../../src/server/dm"
import { MockBridge } from "../fixtures/mock-bridge"

const X_BASE = "https://api.x.com/2"

describe("twitter dm — sendDirectMessage", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    resetBridgeClient()
  })

  it("validates participant_id up-front before any bridge call", async () => {
    const r = await sendDirectMessage({ participant_id: "  ", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("validation_failed")
    expect(bridge.calls).toHaveLength(0)
  })

  it("validates non-empty text up-front", async () => {
    const r = await sendDirectMessage({ participant_id: "12345", text: "" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("validation_failed")
    expect(bridge.calls).toHaveLength(0)
  })

  it("validates the 10000-character cap up-front", async () => {
    const r = await sendDirectMessage({ participant_id: "12345", text: "x".repeat(10_001) })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toMatch(/10000/)
    }
    expect(bridge.calls).toHaveLength(0)
  })

  it("posts to the v2 messages endpoint with the body shape X expects", async () => {
    bridge
      .whenPost("/dm_conversations/with/12345/messages")
      .respond(201, { data: { dm_event_id: "ev_1", dm_conversation_id: "conv_1" } })

    const r = await sendDirectMessage({ participant_id: "12345", text: "hello" })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toEqual({ dm_event_id: "ev_1", dm_conversation_id: "conv_1" })
    }
    expect(bridge.calls).toHaveLength(1)
    expect(bridge.calls[0].method).toBe("POST")
    expect(bridge.calls[0].endpoint).toBe(`${X_BASE}/dm_conversations/with/12345/messages`)
    expect(bridge.calls[0].body).toEqual({ text: "hello" })
  })

  it("URL-encodes the participant_id (defensive — X user ids are numeric, but we trust input less than that)", async () => {
    bridge.whenAny().respond(201, { data: { dm_event_id: "ev", dm_conversation_id: "c" } })
    await sendDirectMessage({ participant_id: "weird/id with spaces", text: "x" })
    expect(bridge.calls[0].endpoint).toContain("weird%2Fid%20with%20spaces")
  })

  it("flags upstream_error when 2xx response is missing dm_event_id (X contract violation)", async () => {
    bridge.whenAny().respond(201, { data: { dm_conversation_id: "c_1" } })
    const r = await sendDirectMessage({ participant_id: "12345", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps 401 to not_connected (token expired)", async () => {
    bridge.whenAny().respond(401, { title: "Unauthorized", detail: "token expired" })
    const r = await sendDirectMessage({ participant_id: "12345", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("not_connected")
      expect(r.error.message).toContain("token expired")
    }
  })

  it("maps 403 to not_connected (DM scope missing)", async () => {
    bridge.whenAny().respond(403, { detail: "missing dm.write" })
    const r = await sendDirectMessage({ participant_id: "12345", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps 404 to not_found (recipient doesn't exist or isn't reachable)", async () => {
    bridge.whenAny().respond(404, { detail: "user not found" })
    const r = await sendDirectMessage({ participant_id: "999999", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_found")
  })

  it("maps 400 to validation_failed (X server-side rejection — e.g. recipient closed DMs)", async () => {
    bridge.whenAny().respond(400, { detail: "Cannot send messages to this user" })
    const r = await sendDirectMessage({ participant_id: "12345", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("Cannot send")
    }
  })

  it("maps 429 to rate_limited and surfaces retry_after", async () => {
    bridge.whenAny().respond(429, { detail: "slow down" }, { "retry-after": "120" })
    const r = await sendDirectMessage({ participant_id: "12345", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(120)
    }
  })

  it("maps 5xx to upstream_error", async () => {
    bridge.whenAny().respond(503, { detail: "service unavailable" })
    const r = await sendDirectMessage({ participant_id: "12345", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps a not-connected broker exception to not_connected", async () => {
    bridge.whenAny().throwOnce(new Error("No twitter integration configured. Connect via Integrations settings."))
    const r = await sendDirectMessage({ participant_id: "12345", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps an arbitrary broker exception to upstream_error", async () => {
    bridge.whenAny().throwOnce(new Error("network down"))
    const r = await sendDirectMessage({ participant_id: "12345", text: "hi" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })
})

describe("twitter dm — listDirectMessages", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    resetBridgeClient()
  })

  it("validates participant_id up-front", async () => {
    const r = await listDirectMessages({ participant_id: "" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("validation_failed")
    expect(bridge.calls).toHaveLength(0)
  })

  it("requests dm_event.fields so X returns text + sender_id + created_at (not just id+event_type)", async () => {
    bridge.whenAny().respond(200, { data: [], meta: { result_count: 0 } })
    await listDirectMessages({ participant_id: "12345" })
    const url = bridge.calls[0].endpoint
    expect(url).toContain("dm_event.fields=")
    expect(url).toContain("text")
    expect(url).toContain("sender_id")
    expect(url).toContain("created_at")
    expect(url).toContain("dm_conversation_id")
  })

  it("clamps max_results to the X cap of 100", async () => {
    bridge.whenAny().respond(200, { data: [], meta: {} })
    await listDirectMessages({ participant_id: "12345", max_results: 999 })
    expect(bridge.calls[0].endpoint).toContain("max_results=100")
  })

  it("clamps max_results to >= 1 if a non-positive value sneaks through", async () => {
    bridge.whenAny().respond(200, { data: [], meta: {} })
    await listDirectMessages({ participant_id: "12345", max_results: 0 })
    expect(bridge.calls[0].endpoint).toContain("max_results=1")
  })

  it("forwards pagination_token when provided", async () => {
    bridge.whenAny().respond(200, { data: [], meta: {} })
    await listDirectMessages({ participant_id: "12345", pagination_token: "abc" })
    expect(bridge.calls[0].endpoint).toContain("pagination_token=abc")
  })

  it("normalises X's raw event shape to DmEvent", async () => {
    bridge.whenAny().respond(200, {
      data: [
        {
          id: "ev_1",
          event_type: "MessageCreate",
          text: "hi there",
          sender_id: "u_1",
          created_at: "2026-04-27T01:23:45Z",
          dm_conversation_id: "conv_xyz",
        },
        {
          id: "ev_2",
          event_type: "ParticipantsJoin",
          dm_conversation_id: "conv_xyz",
        },
      ],
      meta: { result_count: 2, next_token: "page_2" },
    })
    const r = await listDirectMessages({ participant_id: "12345" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.messages).toHaveLength(2)
      expect(r.data.messages[0]).toEqual({
        dm_event_id: "ev_1",
        dm_conversation_id: "conv_xyz",
        event_type: "MessageCreate",
        text: "hi there",
        sender_id: "u_1",
        created_at: "2026-04-27T01:23:45Z",
      })
      expect(r.data.messages[1].event_type).toBe("ParticipantsJoin")
      expect(r.data.messages[1].text).toBeUndefined()
      expect(r.data.next_pagination_token).toBe("page_2")
      expect(r.data.result_count).toBe(2)
    }
  })

  it("returns an empty messages array when X returns no data", async () => {
    bridge.whenAny().respond(200, {})
    const r = await listDirectMessages({ participant_id: "12345" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.messages).toEqual([])
      expect(r.data.result_count).toBe(0)
      expect(r.data.next_pagination_token).toBeUndefined()
    }
  })

  it("maps 401 to not_connected", async () => {
    bridge.whenAny().respond(401, { detail: "expired" })
    const r = await listDirectMessages({ participant_id: "12345" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps 404 to not_found", async () => {
    bridge.whenAny().respond(404, { detail: "user not found" })
    const r = await listDirectMessages({ participant_id: "12345" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_found")
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge.whenAny().respond(429, { detail: "slow" }, { "retry-after": "30" })
    const r = await listDirectMessages({ participant_id: "12345" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(30)
    }
  })

  it("maps 5xx to upstream_error", async () => {
    bridge.whenAny().respond(503, { detail: "boom" })
    const r = await listDirectMessages({ participant_id: "12345" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps a not-connected broker exception to not_connected", async () => {
    bridge
      .whenAny()
      .throwOnce(new Error("No twitter integration configured. Connect via Integrations settings."))
    const r = await listDirectMessages({ participant_id: "12345" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })
})

describe("twitter dm — listRecentDmEvents (inbox-wide)", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    resetBridgeClient()
  })

  it("requests dm_event.fields + expansions=sender_id + user.fields so X returns sender profile inline", async () => {
    bridge.whenAny().respond(200, { data: [], meta: {} })
    await listRecentDmEvents({})
    const url = bridge.calls[0].endpoint
    expect(url).toContain("/dm_events?")
    expect(url).toContain("dm_event.fields=")
    expect(url).toContain("expansions=sender_id")
    expect(url).toContain("user.fields=")
    expect(url).toContain("username")
    expect(url).toContain("name")
  })

  it("does NOT include a participant_id segment in the URL (this is the inbox-wide endpoint)", async () => {
    bridge.whenAny().respond(200, { data: [], meta: {} })
    await listRecentDmEvents({})
    expect(bridge.calls[0].endpoint).not.toContain("/dm_conversations/with/")
  })

  it("clamps max_results to the X cap of 100", async () => {
    bridge.whenAny().respond(200, { data: [], meta: {} })
    await listRecentDmEvents({ max_results: 999 })
    expect(bridge.calls[0].endpoint).toContain("max_results=100")
  })

  it("forwards event_types as a comma-separated query param", async () => {
    bridge.whenAny().respond(200, { data: [], meta: {} })
    await listRecentDmEvents({ event_types: ["MessageCreate", "ParticipantsLeave"] })
    expect(bridge.calls[0].endpoint).toContain("event_types=MessageCreate%2CParticipantsLeave")
  })

  it("omits event_types from the URL when not supplied (X default = everything)", async () => {
    bridge.whenAny().respond(200, { data: [], meta: {} })
    await listRecentDmEvents({})
    expect(bridge.calls[0].endpoint).not.toContain("event_types=")
  })

  it("inlines sender_handle + sender_name from the X users include", async () => {
    bridge.whenAny().respond(200, {
      data: [
        {
          id: "ev_1",
          event_type: "MessageCreate",
          text: "hello",
          sender_id: "u_42",
          created_at: "2026-04-27T10:00:00Z",
          dm_conversation_id: "conv_a",
        },
      ],
      includes: {
        users: [{ id: "u_42", username: "joshua", name: "Joshua A" }],
      },
      meta: { result_count: 1 },
    })
    const r = await listRecentDmEvents({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.messages).toHaveLength(1)
      expect(r.data.messages[0]).toMatchObject({
        sender_id: "u_42",
        sender_handle: "joshua",
        sender_name: "Joshua A",
      })
    }
  })

  it("leaves sender_handle / sender_name undefined when X didn't include the user (rare but possible)", async () => {
    bridge.whenAny().respond(200, {
      data: [
        {
          id: "ev_1",
          event_type: "MessageCreate",
          sender_id: "u_99",
          dm_conversation_id: "conv_a",
        },
      ],
      meta: { result_count: 1 },
      // no `includes`
    })
    const r = await listRecentDmEvents({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.messages[0].sender_id).toBe("u_99")
      expect(r.data.messages[0].sender_handle).toBeUndefined()
      expect(r.data.messages[0].sender_name).toBeUndefined()
    }
  })

  it("forwards pagination_token", async () => {
    bridge.whenAny().respond(200, { data: [], meta: {} })
    await listRecentDmEvents({ pagination_token: "page_2" })
    expect(bridge.calls[0].endpoint).toContain("pagination_token=page_2")
  })

  it("surfaces meta.next_token as next_pagination_token", async () => {
    bridge.whenAny().respond(200, { data: [], meta: { result_count: 0, next_token: "next_page" } })
    const r = await listRecentDmEvents({})
    if (r.ok) expect(r.data.next_pagination_token).toBe("next_page")
  })

  it("handles an empty inbox cleanly", async () => {
    bridge.whenAny().respond(200, {})
    const r = await listRecentDmEvents({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.messages).toEqual([])
      expect(r.data.result_count).toBe(0)
    }
  })

  it("maps 401 to not_connected", async () => {
    bridge.whenAny().respond(401, { detail: "expired" })
    const r = await listRecentDmEvents({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge.whenAny().respond(429, { detail: "slow" }, { "retry-after": "60" })
    const r = await listRecentDmEvents({})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(60)
    }
  })

  it("maps 5xx to upstream_error", async () => {
    bridge.whenAny().respond(502, { detail: "boom" })
    const r = await listRecentDmEvents({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })
})
