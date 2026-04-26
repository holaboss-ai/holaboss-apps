import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { clearActions, listRecentActions, wrapTool } from "../../src/server/audit"
import type { Result, ToolSuccessMeta, ZoomInfoError } from "../../src/lib/types"

describe("audit.wrapTool", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "zoominfo-audit-"))
    resetDbForTests(path.join(tmp, "zoominfo.db"))
    getDb()
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("appends a success row for a successful call", async () => {
    const tool = wrapTool(
      "zoominfo_test_tool",
      async (_args: { foo: string }): Promise<
        Result<{ zoominfo_record_id: string; result_summary: string } & ToolSuccessMeta, ZoomInfoError>
      > => {
        return { ok: true, data: { zoominfo_record_id: "rec_123", result_summary: "did a thing" } }
      },
    )

    const result = await tool({ foo: "bar" })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "zoominfo_test_tool",
      outcome: "success",
      zoominfo_record_id: "rec_123",
      result_summary: "did a thing",
      error_code: null,
      error_message: null,
    })
    expect(JSON.parse(rows[0].args_json)).toEqual({ foo: "bar" })
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0)
  })

  it("appends an error row for a failed call", async () => {
    const tool = wrapTool(
      "zoominfo_test_tool",
      async (): Promise<Result<{ zoominfo_record_id: string }, ZoomInfoError>> => {
        return { ok: false, error: { code: "validation_failed", message: "bad field" } }
      },
    )

    const result = await tool({})
    expect(result.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "zoominfo_test_tool",
      outcome: "error",
      error_code: "validation_failed",
      error_message: "bad field",
      zoominfo_record_id: null,
      result_summary: null,
    })
  })

  it("clearActions truncates the table", async () => {
    const tool = wrapTool(
      "zoominfo_test_tool",
      async (): Promise<Result<Record<string, never>, ZoomInfoError>> => {
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
