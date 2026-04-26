import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { setBridgeClient } from "../../src/server/apollo-client"
import { registerTools } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("apollo MCP registerTools roundtrip", () => {
  let tmp: string
  let bridge: MockBridge

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "apollo-int-"))
    resetDbForTests(path.join(tmp, "apollo.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("registers all 10 tools with names matching app.runtime.yaml", () => {
    const server = new McpServer({ name: "Test", version: "0.0.0" })
    registerTools(server)
    // The MCP SDK exposes registered tools via an internal map keyed by name.
    // We poke at it through the public listTools handler the SDK installs.
    const internal = server as unknown as {
      _registeredTools?: Record<string, unknown>
    }
    const toolNames = Object.keys(internal._registeredTools ?? {}).sort()
    expect(toolNames).toEqual(
      [
        "apollo_add_to_sequence",
        "apollo_enrich_person",
        "apollo_get_connection_status",
        "apollo_get_organization",
        "apollo_get_person",
        "apollo_list_emails_sent",
        "apollo_list_sequences",
        "apollo_remove_from_sequence",
        "apollo_search_organizations",
        "apollo_search_people",
      ].sort(),
    )
  })

  it("a tool call writes a row to agent_actions via wrapTool", async () => {
    bridge.whenGet("/auth/health").respond(200, {
      is_logged_in: true,
      is_master_key: false,
    })
    const server = new McpServer({ name: "Test", version: "0.0.0" })
    registerTools(server)

    const internal = server as unknown as {
      _registeredTools?: Record<string, { handler: (args: unknown) => Promise<unknown> }>
    }
    const tool = internal._registeredTools?.["apollo_get_connection_status"]
    expect(tool).toBeDefined()
    const result = await tool!.handler({})
    expect(result).toBeDefined()
    const r = result as { structuredContent?: { connected?: boolean } }
    expect(r.structuredContent?.connected).toBe(true)

    const { listRecentActions } = await import("../../src/server/audit")
    const rows = listRecentActions({ limit: 10 })
    expect(rows.find((row) => row.tool_name === "apollo_get_connection_status")).toBeDefined()
  })
})
