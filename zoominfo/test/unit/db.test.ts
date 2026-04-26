import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, migrate, resetDbForTests } from "../../src/server/db"

describe("db", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "zoominfo-db-"))
    resetDbForTests(path.join(tmp, "zoominfo.db"))
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("creates agent_actions table with all columns", () => {
    const db = getDb()
    const info = db.prepare("PRAGMA table_info(agent_actions)").all() as Array<{ name: string }>
    const columns = info.map((c) => c.name).sort()
    expect(columns).toEqual(
      [
        "args_json",
        "duration_ms",
        "error_code",
        "error_message",
        "id",
        "outcome",
        "result_summary",
        "timestamp",
        "tool_name",
        "zoominfo_deep_link",
        "zoominfo_object",
        "zoominfo_record_id",
      ].sort(),
    )
  })

  it("creates indexes on timestamp and tool_name", () => {
    const db = getDb()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_actions'")
      .all() as Array<{ name: string }>
    const names = indexes.map((i) => i.name)
    expect(names).toContain("idx_agent_actions_timestamp")
    expect(names).toContain("idx_agent_actions_tool")
  })

  it("migrate is idempotent", () => {
    const db = getDb()
    expect(() => migrate(db)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
  })
})
