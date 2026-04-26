import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, migrate, resetDbForTests } from "../../src/server/db"

describe("db", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "hubspot-db-"))
    resetDbForTests(path.join(tmp, "hubspot.db"))
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("creates agent_actions table with hubspot_* columns", () => {
    const db = getDb()
    const info = db.prepare("PRAGMA table_info(agent_actions)").all() as { name: string }[]
    const columns = info.map((c) => c.name).sort()
    expect(columns).toEqual(
      [
        "args_json",
        "duration_ms",
        "error_code",
        "error_message",
        "hubspot_deep_link",
        "hubspot_object",
        "hubspot_record_id",
        "id",
        "outcome",
        "result_summary",
        "timestamp",
        "tool_name",
      ].sort(),
    )
  })

  it("creates indexes on timestamp and tool_name", () => {
    const db = getDb()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_actions'")
      .all() as { name: string }[]
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
