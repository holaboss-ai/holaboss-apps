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
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "attio.db")
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
  const legacyPath = path.join(process.cwd(), "data", "attio.db")
  if (!existsSync(legacyPath)) return
  const sharedHas = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attio_agent_actions'")
    .get()
  if (sharedHas) return
  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHas = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='agent_actions'")
      .get()
    if (legacyHas) sharedDb.exec("CREATE TABLE attio_agent_actions AS SELECT * FROM legacy.agent_actions")
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
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attio_agent_actions'")
    .get()
  if (oldExists && !newExists) {
    db.exec("ALTER TABLE agent_actions RENAME TO attio_agent_actions")
  }
}

export function migrate(db: Database.Database) {
  // attio_agent_actions = audit log for tool calls (kept).
  //
  // attio_people / attio_companies / attio_deals are local mirrors of
  // the user's standard Attio objects, refreshed every 30 minutes by
  // the in-process scheduler. The agent answers "find that company /
  // who's at deal stage X / who do we know at acme" against the
  // mirror without round-tripping to Attio every chat turn.
  //
  // Attio object schemas are workspace-customizable; we denormalize
  // only the most common identifiers (name + a primary
  // email/domain/stage) for fast SQL filters and keep the full record
  // in `raw` for everything else.
  db.exec(`
    CREATE TABLE IF NOT EXISTS attio_agent_actions (
      id              TEXT PRIMARY KEY,
      timestamp       INTEGER NOT NULL,
      tool_name       TEXT NOT NULL,
      args_json       TEXT NOT NULL,
      outcome         TEXT NOT NULL,
      duration_ms     INTEGER NOT NULL,
      attio_object    TEXT,
      attio_record_id TEXT,
      attio_deep_link TEXT,
      result_summary  TEXT,
      error_code      TEXT,
      error_message   TEXT
    );

    CREATE TABLE IF NOT EXISTS attio_people (
      record_id       TEXT PRIMARY KEY,
      name            TEXT,
      primary_email   TEXT,
      primary_phone   TEXT,
      company_id      TEXT,
      job_title       TEXT,
      raw             TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attio_companies (
      record_id       TEXT PRIMARY KEY,
      name            TEXT,
      primary_domain  TEXT,
      industry        TEXT,
      employee_count  INTEGER,
      raw             TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attio_deals (
      record_id       TEXT PRIMARY KEY,
      name            TEXT,
      stage           TEXT,
      value_amount    REAL,
      value_currency  TEXT,
      company_id      TEXT,
      owner_id        TEXT,
      raw             TEXT,
      created_at      TEXT,
      updated_at      TEXT,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attio_sync_runs (
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

    CREATE TABLE IF NOT EXISTS attio_api_usage (
      date               TEXT PRIMARY KEY,
      calls_succeeded    INTEGER NOT NULL DEFAULT 0,
      calls_failed       INTEGER NOT NULL DEFAULT 0,
      calls_rate_limited INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attio_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_attio_agent_actions_timestamp ON attio_agent_actions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_attio_agent_actions_tool ON attio_agent_actions (tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_attio_people_email ON attio_people(primary_email);
    CREATE INDEX IF NOT EXISTS idx_attio_people_company ON attio_people(company_id);
    CREATE INDEX IF NOT EXISTS idx_attio_companies_domain ON attio_companies(primary_domain);
    CREATE INDEX IF NOT EXISTS idx_attio_deals_stage ON attio_deals(stage);
    CREATE INDEX IF NOT EXISTS idx_attio_sync_runs_started ON attio_sync_runs(started_at DESC);
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
