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
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "calcom.db")
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
  const legacyPath = path.join(process.cwd(), "data", "calcom.db")
  if (!existsSync(legacyPath)) return
  const sharedHas = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calcom_agent_actions'")
    .get()
  if (sharedHas) return
  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHas = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='agent_actions'")
      .get()
    if (legacyHas) sharedDb.exec("CREATE TABLE calcom_agent_actions AS SELECT * FROM legacy.agent_actions")
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
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calcom_agent_actions'")
    .get()
  if (oldExists && !newExists) {
    db.exec("ALTER TABLE agent_actions RENAME TO calcom_agent_actions")
  }
}

export function migrate(db: Database.Database) {
  // calcom_agent_actions = the existing tool-call audit log (kept).
  //
  // calcom_bookings is a local mirror of the user's Cal.com bookings,
  // synced every 15 minutes by the in-process scheduler so the agent
  // can answer "what's on my calendar / who am I meeting / when am I
  // free" without round-tripping to Cal.com on every chat turn.
  // status mirrors Cal.com's lifecycle: accepted / pending / rejected
  // / cancelled / no_show.
  //
  // calcom_sync_runs / calcom_api_usage / calcom_settings follow the
  // cross-app convention.
  db.exec(`
    CREATE TABLE IF NOT EXISTS calcom_agent_actions (
      id              TEXT PRIMARY KEY,
      timestamp       INTEGER NOT NULL,
      tool_name       TEXT NOT NULL,
      args_json       TEXT NOT NULL,
      outcome         TEXT NOT NULL,
      duration_ms     INTEGER NOT NULL,
      calcom_object    TEXT,
      calcom_record_id TEXT,
      calcom_deep_link TEXT,
      result_summary  TEXT,
      error_code      TEXT,
      error_message   TEXT
    );

    CREATE TABLE IF NOT EXISTS calcom_bookings (
      uid               TEXT PRIMARY KEY,
      title             TEXT,
      description       TEXT,
      status            TEXT,
      event_type_id     INTEGER,
      event_type_slug   TEXT,
      start_time        TEXT,
      end_time          TEXT,
      duration_minutes  INTEGER,
      attendees_json    TEXT,
      meeting_url       TEXT,
      cancellation_reason TEXT,
      rescheduled       INTEGER NOT NULL DEFAULT 0,
      raw               TEXT,
      created_at        TEXT,
      updated_at        TEXT,
      synced_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calcom_sync_runs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at        TEXT NOT NULL,
      finished_at       TEXT,
      kind              TEXT NOT NULL DEFAULT 'incremental',
      bookings_seen     INTEGER NOT NULL DEFAULT 0,
      bookings_inserted INTEGER NOT NULL DEFAULT 0,
      bookings_updated  INTEGER NOT NULL DEFAULT 0,
      errors_json       TEXT
    );

    CREATE TABLE IF NOT EXISTS calcom_api_usage (
      date               TEXT PRIMARY KEY,
      calls_succeeded    INTEGER NOT NULL DEFAULT 0,
      calls_failed       INTEGER NOT NULL DEFAULT 0,
      calls_rate_limited INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calcom_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_calcom_agent_actions_timestamp ON calcom_agent_actions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_calcom_agent_actions_tool ON calcom_agent_actions (tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_calcom_bookings_status ON calcom_bookings(status);
    CREATE INDEX IF NOT EXISTS idx_calcom_bookings_start ON calcom_bookings(start_time);
    CREATE INDEX IF NOT EXISTS idx_calcom_bookings_synced ON calcom_bookings(synced_at);
    CREATE INDEX IF NOT EXISTS idx_calcom_sync_runs_started ON calcom_sync_runs(started_at DESC);
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
