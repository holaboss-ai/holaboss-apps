import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { clearActions, listRecentActions, wrapTool } from "../../src/server/audit"
import type { AttioError, Result, ToolSuccessMeta } from "../../src/lib/types"

describe("audit.wrapTool", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-audit-"))
    resetDbForTests(path.join(tmp, "attio.db"))
    getDb()
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("appends a success row for a successful call", async () => {
    const tool = wrapTool("attio_test_tool", async (_args: { foo: string }): Promise<Result<{ attio_record_id: string; result_summary: string } & ToolSuccessMeta, AttioError>> => {
      return { ok: true, data: { attio_record_id: "rec_123", result_summary: "did a thing" } }
    })

    const result = await tool({ foo: "bar" })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "attio_test_tool",
      outcome: "success",
      attio_record_id: "rec_123",
      result_summary: "did a thing",
      error_code: null,
      error_message: null,
    })
    expect(JSON.parse(rows[0].args_json)).toEqual({ foo: "bar" })
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0)
  })

  it("appends an error row for a failed call", async () => {
    const tool = wrapTool("attio_test_tool", async (): Promise<Result<{ attio_record_id: string }, AttioError>> => {
      return { ok: false, error: { code: "validation_failed", message: "bad field" } }
    })

    const result = await tool({})
    expect(result.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "attio_test_tool",
      outcome: "error",
      error_code: "validation_failed",
      error_message: "bad field",
      attio_record_id: null,
      result_summary: null,
    })
  })

  it("listRecentActions orders by timestamp DESC", async () => {
    const tool = wrapTool("attio_test_tool", async (): Promise<Result<Record<string, never>, AttioError>> => {
      return { ok: true, data: {} }
    })
    await tool({ n: 1 })
    await new Promise((r) => setTimeout(r, 5))
    await tool({ n: 2 })
    await new Promise((r) => setTimeout(r, 5))
    await tool({ n: 3 })

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(3)
    const args = rows.map((r) => JSON.parse(r.args_json).n)
    expect(args).toEqual([3, 2, 1])
  })

  it("clearActions truncates the table", async () => {
    const tool = wrapTool("attio_test_tool", async (): Promise<Result<Record<string, never>, AttioError>> => {
      return { ok: true, data: {} }
    })
    await tool({})
    await tool({})
    expect(listRecentActions({ limit: 10 })).toHaveLength(2)

    const deleted = clearActions()
    expect(deleted).toBe(2)
    expect(listRecentActions({ limit: 10 })).toHaveLength(0)
  })
})