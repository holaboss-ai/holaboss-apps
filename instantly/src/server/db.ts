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
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "instantly.db")
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
  const legacyPath = path.join(process.cwd(), "data", "instantly.db")
  if (!existsSync(legacyPath)) return
  const sharedHas = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instantly_agent_actions'")
    .get()
  if (sharedHas) return
  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHas = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='agent_actions'")
      .get()
    if (legacyHas) sharedDb.exec("CREATE TABLE instantly_agent_actions AS SELECT * FROM legacy.agent_actions")
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
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instantly_agent_actions'")
    .get()
  if (oldExists && !newExists) {
    db.exec("ALTER TABLE agent_actions RENAME TO instantly_agent_actions")
  }
}

export function migrate(db: Database.Database) {
  // instantly_agent_actions = audit log (kept).
  //
  // instantly_campaigns / instantly_leads mirror the user's cold
  // email campaigns and the leads on them, refreshed every 30
  // minutes. Agent answers "what campaigns are running / who
  // replied / what's the bounce rate" against the mirror.
  db.exec(`
    CREATE TABLE IF NOT EXISTS instantly_agent_actions (
      id              TEXT PRIMARY KEY,
      timestamp       INTEGER NOT NULL,
      tool_name       TEXT NOT NULL,
      args_json       TEXT NOT NULL,
      outcome         TEXT NOT NULL,
      duration_ms     INTEGER NOT NULL,
      instantly_object    TEXT,
      instantly_record_id TEXT,
      instantly_deep_link TEXT,
      result_summary  TEXT,
      error_code      TEXT,
      error_message   TEXT
    );

    CREATE TABLE IF NOT EXISTS instantly_campaigns (
      record_id        TEXT PRIMARY KEY,
      name             TEXT,
      status           TEXT,
      sent_count       INTEGER,
      open_count       INTEGER,
      reply_count      INTEGER,
      bounce_count     INTEGER,
      raw              TEXT,
      created_at       TEXT,
      updated_at       TEXT,
      synced_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS instantly_leads (
      record_id       TEXT PRIMARY KEY,
      email           TEXT,
      first_name      TEXT,
      last_name       TEXT,
      company         TEXT,
      status          TEXT,
      campaign_id     TEXT,
      raw             TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS instantly_sync_runs (
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

    CREATE TABLE IF NOT EXISTS instantly_api_usage (
      date               TEXT PRIMARY KEY,
      calls_succeeded    INTEGER NOT NULL DEFAULT 0,
      calls_failed       INTEGER NOT NULL DEFAULT 0,
      calls_rate_limited INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS instantly_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_instantly_agent_actions_timestamp ON instantly_agent_actions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_instantly_agent_actions_tool ON instantly_agent_actions (tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_instantly_leads_email ON instantly_leads(email);
    CREATE INDEX IF NOT EXISTS idx_instantly_leads_campaign ON instantly_leads(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_instantly_campaigns_status ON instantly_campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_instantly_sync_runs_started ON instantly_sync_runs(started_at DESC);
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
