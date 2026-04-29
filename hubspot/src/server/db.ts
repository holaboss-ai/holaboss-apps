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
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "hubspot.db")
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
  const legacyPath = path.join(process.cwd(), "data", "hubspot.db")
  if (!existsSync(legacyPath)) return
  const sharedHas = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hubspot_agent_actions'")
    .get()
  if (sharedHas) return
  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHas = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='agent_actions'")
      .get()
    if (legacyHas) sharedDb.exec("CREATE TABLE hubspot_agent_actions AS SELECT * FROM legacy.agent_actions")
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
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hubspot_agent_actions'")
    .get()
  if (oldExists && !newExists) {
    db.exec("ALTER TABLE agent_actions RENAME TO hubspot_agent_actions")
  }
}

export function migrate(db: Database.Database) {
  // hubspot_agent_actions = audit log (kept).
  //
  // hubspot_contacts / hubspot_companies / hubspot_deals are local
  // mirrors of the user's HubSpot CRM, refreshed every 30 minutes.
  // The agent answers "find that contact / what deals are open / who
  // works at acme" against the mirror without round-tripping to
  // HubSpot every chat turn.
  //
  // We store a few hot, denormalized fields per object plus the full
  // properties map in `raw` (JSON). Schema differs only for object-
  // specific identifiers; everything else stays in `raw`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hubspot_agent_actions (
      id              TEXT PRIMARY KEY,
      timestamp       INTEGER NOT NULL,
      tool_name       TEXT NOT NULL,
      args_json       TEXT NOT NULL,
      outcome         TEXT NOT NULL,
      duration_ms     INTEGER NOT NULL,
      hubspot_object    TEXT,
      hubspot_record_id TEXT,
      hubspot_deep_link TEXT,
      result_summary  TEXT,
      error_code      TEXT,
      error_message   TEXT
    );

    CREATE TABLE IF NOT EXISTS hubspot_contacts (
      record_id       TEXT PRIMARY KEY,
      first_name      TEXT,
      last_name       TEXT,
      email           TEXT,
      phone           TEXT,
      company         TEXT,
      job_title       TEXT,
      lifecycle_stage TEXT,
      raw             TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hubspot_companies (
      record_id       TEXT PRIMARY KEY,
      name            TEXT,
      domain          TEXT,
      industry        TEXT,
      employee_count  INTEGER,
      annual_revenue  REAL,
      raw             TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hubspot_deals (
      record_id       TEXT PRIMARY KEY,
      name            TEXT,
      stage           TEXT,
      pipeline        TEXT,
      amount          REAL,
      close_date      TEXT,
      owner_id        TEXT,
      raw             TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hubspot_sync_runs (
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

    CREATE TABLE IF NOT EXISTS hubspot_api_usage (
      date               TEXT PRIMARY KEY,
      calls_succeeded    INTEGER NOT NULL DEFAULT 0,
      calls_failed       INTEGER NOT NULL DEFAULT 0,
      calls_rate_limited INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hubspot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_hubspot_agent_actions_timestamp ON hubspot_agent_actions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_hubspot_agent_actions_tool ON hubspot_agent_actions (tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_hubspot_contacts_email ON hubspot_contacts(email);
    CREATE INDEX IF NOT EXISTS idx_hubspot_contacts_company ON hubspot_contacts(company);
    CREATE INDEX IF NOT EXISTS idx_hubspot_companies_domain ON hubspot_companies(domain);
    CREATE INDEX IF NOT EXISTS idx_hubspot_deals_stage ON hubspot_deals(stage);
    CREATE INDEX IF NOT EXISTS idx_hubspot_deals_pipeline ON hubspot_deals(pipeline);
    CREATE INDEX IF NOT EXISTS idx_hubspot_sync_runs_started ON hubspot_sync_runs(started_at DESC);
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
