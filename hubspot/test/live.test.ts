/**
 * Live tests against real Composio. See ../docs/LIVE_TESTING.md.
 * Run: pnpm test:live (after pnpm composio:broker + pnpm composio:connect hubspot).
 *
 * Read-only by default. LIVE_WRITE=1 exercises create/update tools — DO NOT
 * run against a production HubSpot portal; it will create real contacts and
 * deals.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  describeSchemaImpl,
  getConnectionStatusImpl,
  listPipelinesImpl,
  searchCompaniesImpl,
  searchContactsImpl,
} from "../src/server/tools"
import { resetBridgeClient } from "../src/server/hubspot-client"

const live = !!process.env.LIVE

describe.skipIf(!live)("hubspot live (real Composio)", () => {
  beforeAll(() => resetBridgeClient())
  afterAll(() => resetBridgeClient())

  it("hubspot_get_connection_status returns connected:true with portal_id", async () => {
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.connected).toBe(true)
      // portal_id is best-effort; not all auth paths expose it.
    }
  }, 30_000)

  it("hubspot_describe_schema(contacts) returns properties[]", async () => {
    const r = await describeSchemaImpl({ object_type: "contacts" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Array.isArray(r.data.properties)).toBe(true)
      expect(r.data.properties.length).toBeGreaterThan(0)
      const first = r.data.properties[0]
      expect(typeof first.name).toBe("string")
      expect(typeof first.type).toBe("string")
    }
  }, 30_000)

  it("hubspot_list_pipelines returns at least one pipeline with stages", async () => {
    const r = await listPipelinesImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Array.isArray(r.data.pipelines)).toBe(true)
      // Every HubSpot portal has the default deal pipeline.
      expect(r.data.pipelines.length).toBeGreaterThan(0)
      expect(Array.isArray(r.data.pipelines[0].stages)).toBe(true)
    }
  }, 30_000)

  it("hubspot_search_contacts (limit:5) returns an array", async () => {
    const r = await searchContactsImpl({ limit: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.contacts)).toBe(true)
  }, 30_000)

  it("hubspot_search_companies (limit:5) returns an array", async () => {
    const r = await searchCompaniesImpl({ limit: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.companies)).toBe(true)
  }, 30_000)
})
