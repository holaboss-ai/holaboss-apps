import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { clearActions, listRecentActions, wrapTool } from "../../src/server/audit"
import type { HubspotError, Result, ToolSuccessMeta } from "../../src/lib/types"

describe("audit.wrapTool", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "hubspot-audit-"))
    resetDbForTests(path.join(tmp, "hubspot.db"))
    getDb()
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("appends a success row for a successful call", async () => {
    const tool = wrapTool(
      "hubspot_test_tool",
      async (
        _args: { foo: string },
      ): Promise<Result<{ hubspot_record_id: string; result_summary: string } & ToolSuccessMeta, HubspotError>> => {
        return { ok: true, data: { hubspot_record_id: "rec_123", result_summary: "did a thing" } }
      },
    )

    const result = await tool({ foo: "bar" })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "hubspot_test_tool",
      outcome: "success",
      hubspot_record_id: "rec_123",
      result_summary: "did a thing",
      error_code: null,
      error_message: null,
    })
    expect(JSON.parse(rows[0].args_json)).toEqual({ foo: "bar" })
  })

  it("appends an error row for a failed call", async () => {
    const tool = wrapTool(
      "hubspot_test_tool",
      async (): Promise<Result<{ hubspot_record_id: string }, HubspotError>> => {
        return { ok: false, error: { code: "validation_failed", message: "bad field" } }
      },
    )

    const result = await tool({})
    expect(result.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "hubspot_test_tool",
      outcome: "error",
      error_code: "validation_failed",
      error_message: "bad field",
      hubspot_record_id: null,
      result_summary: null,
    })
  })

  it("clearActions truncates the table", async () => {
    const tool = wrapTool(
      "hubspot_test_tool",
      async (): Promise<Result<Record<string, never>, HubspotError>> => {
        return { ok: true, data: {} }
      },
    )
    await tool({})
    await tool({})
    expect(listRecentActions({ limit: 10 })).toHaveLength(2)

    const deleted = clearActions()
    expect(deleted).toBe(2)
    expect(listRecentActions({ limit: 10 })).toHaveLength(0)
  })
})
