import { getWorkspaceDb } from "@holaboss/bridge"
import Database from "better-sqlite3"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import path from "node:path"

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  if (process.env.WORKSPACE_DB_PATH) {
    _db = getWorkspaceDb() as unknown as Database.Database
    migrateLegacyPrivateDb(_db)
  } else {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "apollo.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    _db = new Database(dbPath)
    _db.pragma("journal_mode = WAL")
    _db.pragma("foreign_keys = ON")
  }

  renameLegacyTablesIfNeeded(_db)
  migrate(_db)
  return _db
}

function migrateLegacyPrivateDb(sharedDb: Database.Database): void {
  const legacyPath = path.join(process.cwd(), "data", "apollo.db")
  if (!existsSync(legacyPath)) return
  const sharedHas = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='apollo_agent_actions'")
    .get()
  if (sharedHas) return
  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHas = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='agent_actions'")
      .get()
    if (legacyHas) sharedDb.exec("CREATE TABLE apollo_agent_actions AS SELECT * FROM legacy.agent_actions")
  } finally {
    sharedDb.exec("DETACH DATABASE legacy")
  }
  renameSync(legacyPath, `${legacyPath}.bak`)
}

function renameLegacyTablesIfNeeded(db: Database.Database): void {
  const oldExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_actions'")
    .get()
  const newExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='apollo_agent_actions'")
    .get()
  if (oldExists && !newExists) {
    db.exec("ALTER TABLE agent_actions RENAME TO apollo_agent_actions")
  }
}

export function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apollo_agent_actions (
      id              TEXT PRIMARY KEY,
      timestamp       INTEGER NOT NULL,
      tool_name       TEXT NOT NULL,
      args_json       TEXT NOT NULL,
      outcome         TEXT NOT NULL,
      duration_ms     INTEGER NOT NULL,
      apollo_object    TEXT,
      apollo_record_id TEXT,
      apollo_deep_link TEXT,
      result_summary  TEXT,
      error_code      TEXT,
      error_message   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_apollo_agent_actions_timestamp ON apollo_agent_actions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_apollo_agent_actions_tool ON apollo_agent_actions (tool_name, timestamp DESC);
  `)
}

export function closeDb() {
  _db?.close()
  _db = null
}

export function resetDbForTests(dbPath: string) {
  if (_db) {
    _db.close()
    _db = null
  }
  process.env.DB_PATH = dbPath
}
