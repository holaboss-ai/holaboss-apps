/**
 * MCP roundtrip integration test.
 *
 * Wires the real `registerTools(server)` function to an in-memory MCP server,
 * connects a real MCP client, and verifies:
 *   - All 7 zoominfo_* tools are listed via tools/list with their annotations.
 *   - tools/call returns structuredContent for at least 2 tools and the shape
 *     matches the registered outputSchema.
 *   - tools/call returns isError + structured error envelope for a failure.
 *
 * Plan §8 — "registerTool wiring + structuredContent matches outputSchema for
 * at least 2 tools" — is the contract this test enforces.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { registerTools } from "../../src/server/tools"
import { setBridgeClient } from "../../src/server/zoominfo-client"
import { MockBridge } from "../fixtures/mock-bridge"

const EXPECTED_TOOLS = [
  "zoominfo_get_connection_status",
  "zoominfo_search_contacts",
  "zoominfo_enrich_contact",
  "zoominfo_search_companies",
  "zoominfo_enrich_company",
  "zoominfo_get_intent",
  "zoominfo_get_org_chart",
] as const

describe("MCP roundtrip — registerTools wiring", () => {
  let bridge: MockBridge
  let tmp: string
  let client: Client
  let server: McpServer

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "zoominfo-mcp-rt-"))
    resetDbForTests(path.join(tmp, "zoominfo.db"))
    getDb()

    bridge = new MockBridge()
    // Default: just the connection-status probe path returns 200 — every other
    // call must register its own rule (otherwise mock-bridge throws no-match,
    // which is the desired "did the test forget to mock?" signal).
    bridge.whenGet("/lookup/inputfields/contact/search").respond(200, {})
    setBridgeClient(bridge.asClient())

    server = new McpServer({ name: "zoominfo-test", version: "0.0.0" })
    registerTools(server)

    client = new Client({ name: "zoominfo-test-client", version: "0.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  })

  afterEach(async () => {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
    setBridgeClient(null)
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("lists all 7 zoominfo_* tools with read-only annotations", async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...EXPECTED_TOOLS].sort())
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
      expect(tool.annotations?.destructiveHint).toBe(false)
      expect(tool.annotations?.idempotentHint).toBe(true)
      expect(tool.annotations?.openWorldHint).toBe(true)
      // Description must mention licensing per plan §3.
      expect(tool.description).toMatch(/licensed/i)
    }
  })

  it("zoominfo_get_connection_status returns structuredContent matching outputSchema", async () => {
    const result = await client.callTool({
      name: "zoominfo_get_connection_status",
      arguments: {},
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toBeDefined()
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.connected).toBe(true)
    // Output meta from ToolSuccessMetaShape.
    expect(typeof sc.zoominfo_object).toBe("string")
    expect(typeof sc.result_summary).toBe("string")
  })

  it("zoominfo_search_companies returns structuredContent matching outputSchema", async () => {
    bridge.whenPost("/search/company").respond(200, {
      totalResults: 1,
      data: [
        {
          id: "c_42",
          name: "Acme",
          website: "acme.com",
          industry: "Computer Software",
          employeeCount: 250,
          revenue: 50_000_000,
          country: "US",
        },
      ],
    })
    const result = await client.callTool({
      name: "zoominfo_search_companies",
      arguments: { industries: ["Computer Software"], page: 1, page_size: 25 },
    })
    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as Record<string, unknown>
    expect(Array.isArray(sc.companies)).toBe(true)
    const companies = sc.companies as Array<Record<string, unknown>>
    expect(companies).toHaveLength(1)
    expect(companies[0].id).toBe("c_42")
    expect(companies[0].domain).toBe("acme.com")
    expect(companies[0].employee_count).toBe(250)
    expect(typeof sc.has_next).toBe("boolean")
    expect(sc.page).toBe(1)
    expect(sc.page_size).toBe(25)
  })

  it("zoominfo_enrich_contact returns structured error envelope on validation_failed", async () => {
    const result = await client.callTool({
      name: "zoominfo_enrich_contact",
      arguments: {},
    })
    expect(result.isError).toBe(true)
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.code).toBe("validation_failed")
    expect(typeof sc.message).toBe("string")
  })
})
