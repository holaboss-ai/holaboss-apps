import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { setBridgeClient } from "../../src/server/hubspot-client"
import { resetPortalIdCacheForTests } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"
import { createMcpServer } from "../../src/server/mcp"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

/**
 * MCP round-trip: client connects to the server in-process and calls each tool.
 * Verifies that registerTool wiring is correct, descriptions/schemas appear on
 * list-tools, and the structuredContent shape matches each tool's outputSchema.
 */
describe("MCP round-trip", () => {
  let tmp: string
  let bridge: MockBridge

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "hubspot-mcp-"))
    resetDbForTests(path.join(tmp, "hubspot.db"))
    getDb()
    resetPortalIdCacheForTests()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  async function connectClient() {
    const server = createMcpServer()
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test", version: "1.0.0" }, {})
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return client
  }

  it("registers all 12 tools with hubspot_ prefix", async () => {
    const client = await connectClient()
    const list = await client.listTools()
    const names = list.tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        "hubspot_add_note",
        "hubspot_create_contact",
        "hubspot_create_deal",
        "hubspot_create_task",
        "hubspot_describe_schema",
        "hubspot_get_connection_status",
        "hubspot_get_contact",
        "hubspot_list_pipelines",
        "hubspot_search_companies",
        "hubspot_search_contacts",
        "hubspot_update_contact",
        "hubspot_update_deal_stage",
      ].sort(),
    )
    await client.close()
  })

  it("get_connection_status returns structuredContent matching outputSchema", async () => {
    bridge.whenGet("/account-info/v3/details").respond(200, { portalId: 1234 })

    const client = await connectClient()
    const r = await client.callTool({ name: "hubspot_get_connection_status", arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ connected: true, portal_id: "1234" })
    await client.close()
  })

  it("list_pipelines surfaces structured pipelines + stages", async () => {
    bridge.whenGet("/crm/v3/pipelines/deals").respond(200, {
      results: [
        {
          id: "default",
          label: "Sales",
          stages: [{ id: "qualified", label: "Qualified", displayOrder: 1, metadata: { probability: "0.3" } }],
        },
      ],
    })
    const client = await connectClient()
    const r = await client.callTool({ name: "hubspot_list_pipelines", arguments: {} })
    expect(r.isError).toBeFalsy()
    const sc = r.structuredContent as { pipelines: Array<{ pipeline_id: string }> }
    expect(sc.pipelines).toHaveLength(1)
    expect(sc.pipelines[0].pipeline_id).toBe("default")
    await client.close()
  })

  it("error envelope is JSON in text content with isError=true", async () => {
    bridge.whenGet("/crm/v3/objects/contacts/missing").respond(404, { message: "Contact not found" })

    const client = await connectClient()
    const r = await client.callTool({
      name: "hubspot_get_contact",
      arguments: { contact_id: "missing" },
    })
    expect(r.isError).toBe(true)
    const text = (r.content as Array<{ type: string; text: string }>)[0].text
    const parsed = JSON.parse(text)
    expect(parsed.code).toBe("not_found")
    await client.close()
  })
})
