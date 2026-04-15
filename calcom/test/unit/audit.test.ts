import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { clearActions, listRecentActions, wrapTool } from "../../src/server/audit"
import type { Result, CalcomError } from "../../src/lib/types"

describe("audit.wrapTool", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "calcom-audit-"))
    resetDbForTests(path.join(tmp, "calcom.db"))
    getDb()
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("appends a success row for a successful call", async () => {
    const tool = wrapTool(
      "calcom_test_tool",
      async (_args: { foo: string }): Promise<Result<{ calcom_record_id: string; result_summary: string }, CalcomError>> => {
        return { ok: true, data: { calcom_record_id: "bk_1", result_summary: "cancelled booking bk_1" } }
      },
    )

    const result = await tool({ foo: "bar" })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "calcom_test_tool",
      outcome: "success",
      calcom_record_id: "bk_1",
      result_summary: "cancelled booking bk_1",
      error_code: null,
    })
    expect(JSON.parse(rows[0].args_json)).toEqual({ foo: "bar" })
  })

  it("appends an error row for a failed call", async () => {
    const tool = wrapTool("calcom_test_tool", async (): Promise<Result<{ calcom_record_id: string }, CalcomError>> => {
      return { ok: false, error: { code: "validation_failed", message: "Booking not found" } }
    })

    const result = await tool({})
    expect(result.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    expect(rows[0]).toMatchObject({
      outcome: "error",
      error_code: "validation_failed",
      error_message: "Booking not found",
      calcom_record_id: null,
    })
  })

  it("listRecentActions orders by timestamp DESC", async () => {
    const tool = wrapTool("calcom_test_tool", async (): Promise<Result<Record<string, never>, CalcomError>> => ({ ok: true, data: {} }))
    await tool({ n: 1 })
    await new Promise((r) => setTimeout(r, 5))
    await tool({ n: 2 })
    await new Promise((r) => setTimeout(r, 5))
    await tool({ n: 3 })
    const rows = listRecentActions({ limit: 10 })
    expect(rows.map((r) => JSON.parse(r.args_json).n)).toEqual([3, 2, 1])
  })

  it("clearActions truncates the table", async () => {
    const tool = wrapTool("calcom_test_tool", async (): Promise<Result<Record<string, never>, CalcomError>> => ({ ok: true, data: {} }))
    await tool({})
    await tool({})
    expect(clearActions()).toBe(2)
    expect(listRecentActions({ limit: 10 })).toHaveLength(0)
  })
})