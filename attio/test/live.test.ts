/**
 * Live tests against real Composio. See ../docs/LIVE_TESTING.md.
 * Run: pnpm test:live (after pnpm composio:broker + pnpm composio:connect attio).
 *
 * Read-only by default. LIVE_WRITE=1 would exercise create_person /
 * create_company / add_note — gated because those mutate a real workspace.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  describeSchemaImpl,
  findCompaniesImpl,
  findPeopleImpl,
  getConnectionStatusImpl,
  listTasksImpl,
} from "../src/server/tools"
import { resetBridgeClient } from "../src/server/attio-client"

const live = !!process.env.LIVE

describe.skipIf(!live)("attio live (real Composio)", () => {
  beforeAll(() => resetBridgeClient())
  afterAll(() => resetBridgeClient())

  it("attio_get_connection_status returns connected:true", async () => {
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.connected).toBe(true)
  }, 30_000)

  it("attio_describe_schema(['people','companies']) returns objects[]", async () => {
    const r = await describeSchemaImpl({ objects: ["people", "companies"] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Array.isArray(r.data.objects)).toBe(true)
      expect(r.data.objects.length).toBeGreaterThanOrEqual(1)
      expect(Array.isArray(r.data.objects[0].attributes)).toBe(true)
    }
  }, 30_000)

  it("attio_find_people returns an array (may be empty for a new workspace)", async () => {
    const r = await findPeopleImpl({ query: "a", limit: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.records)).toBe(true)
  }, 30_000)

  it("attio_find_companies returns an array", async () => {
    const r = await findCompaniesImpl({ query: "a", limit: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.records)).toBe(true)
  }, 30_000)

  it("attio_list_tasks returns an array", async () => {
    const r = await listTasksImpl({ limit: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.isArray(r.data.tasks)).toBe(true)
  }, 30_000)
})
