import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import path from "node:path"

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "apollo.db")
  mkdirSync(path.dirname(dbPath), { recursive: true })

  _db = new Database(dbPath)
  _db.pragma("journal_mode = WAL")
  _db.pragma("foreign_keys = ON")
  migrate(_db)
  return _db
}

export function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_actions (
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

    CREATE INDEX IF NOT EXISTS idx_agent_actions_timestamp ON agent_actions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_tool ON agent_actions (tool_name, timestamp DESC);
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
