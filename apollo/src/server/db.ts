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
  // apollo_agent_actions = audit log (kept).
  //
  // apollo_campaigns / apollo_contacts mirror the user's outreach
  // sequences and the prospects on them, refreshed every 30 minutes
  // by the in-process scheduler. The agent answers "what's the
  // status of my outreach to acme / who replied last week" against
  // the mirror without round-tripping every chat turn.
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

    CREATE TABLE IF NOT EXISTS apollo_campaigns (
      record_id       TEXT PRIMARY KEY,
      name            TEXT,
      label           TEXT,
      status          TEXT,
      num_steps       INTEGER,
      num_contacts    INTEGER,
      raw             TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS apollo_contacts (
      record_id       TEXT PRIMARY KEY,
      first_name      TEXT,
      last_name       TEXT,
      email           TEXT,
      title           TEXT,
      company_name    TEXT,
      campaign_id     TEXT,
      replied         INTEGER NOT NULL DEFAULT 0,
      raw             TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS apollo_sync_runs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at        TEXT NOT NULL,
      finished_at       TEXT,
      kind              TEXT NOT NULL DEFAULT 'incremental',
      object_slug       TEXT NOT NULL,
      records_seen      INTEGER NOT NULL DEFAULT 0,
      records_inserted  INTEGER NOT NULL DEFAULT 0,
      records_updated   INTEGER NOT NULL DEFAULT 0,
      errors_json       TEXT
    );

    CREATE TABLE IF NOT EXISTS apollo_api_usage (
      date               TEXT PRIMARY KEY,
      calls_succeeded    INTEGER NOT NULL DEFAULT 0,
      calls_failed       INTEGER NOT NULL DEFAULT 0,
      calls_rate_limited INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS apollo_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_apollo_agent_actions_timestamp ON apollo_agent_actions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_apollo_agent_actions_tool ON apollo_agent_actions (tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_apollo_contacts_email ON apollo_contacts(email);
    CREATE INDEX IF NOT EXISTS idx_apollo_contacts_campaign ON apollo_contacts(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_apollo_campaigns_status ON apollo_campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_apollo_sync_runs_started ON apollo_sync_runs(started_at DESC);
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
