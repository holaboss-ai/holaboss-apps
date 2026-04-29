import { getWorkspaceDb } from "@holaboss/bridge"
import Database from "better-sqlite3"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import path from "node:path"

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  if (process.env.WORKSPACE_DB_PATH) {
    db = getWorkspaceDb() as unknown as Database.Database
    migrateLegacyPrivateDb(db)
  } else {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "module.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    db = new Database(dbPath)
    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")
  }

  renameLegacyTablesIfNeeded(db)
  ensureSchema(db)
  return db
}

function migrateLegacyPrivateDb(sharedDb: Database.Database): void {
  const legacyPath = path.join(process.cwd(), "data", "module.db")
  if (!existsSync(legacyPath)) return
  const sharedHasDrafts = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gmail_drafts'")
    .get()
  if (sharedHasDrafts) return
  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHasDrafts = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='drafts'")
      .get()
    if (legacyHasDrafts) sharedDb.exec("CREATE TABLE gmail_drafts AS SELECT * FROM legacy.drafts")
    const legacyHasJobs = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='jobs'")
      .get()
    if (legacyHasJobs) sharedDb.exec("CREATE TABLE gmail_jobs AS SELECT * FROM legacy.jobs")
  } finally {
    sharedDb.exec("DETACH DATABASE legacy")
  }
  renameSync(legacyPath, `${legacyPath}.bak`)
}

function renameLegacyTablesIfNeeded(db: Database.Database): void {
  const renameIfNeeded = (oldName: string, newName: string) => {
    const oldExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(oldName)
    const newExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(newName)
    if (oldExists && !newExists) db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`)
  }
  renameIfNeeded("drafts", "gmail_drafts")
  renameIfNeeded("jobs", "gmail_jobs")
}

function ensureSchema(db: Database.Database): void {
  // gmail_drafts / gmail_jobs = existing draft outbox state.
  //
  // gmail_threads is a local mirror of the user's Gmail threads from
  // the last 30 days, refreshed every 15 minutes. The agent answers
  // "who emailed me about X / what's the latest from acme" against
  // the mirror without round-tripping every chat turn.
  //
  // Schema: history_id is Gmail's per-thread version. A list response
  // gives us (id, historyId) cheaply; we only fetch full thread
  // metadata when historyId differs from the row we've cached.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gmail_drafts (
      id TEXT PRIMARY KEY,
      to_email TEXT NOT NULL,
      gmail_thread_id TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      output_id TEXT,
      sent_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gmail_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'send',
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gmail_threads (
      thread_id        TEXT PRIMARY KEY,
      history_id       TEXT,
      subject          TEXT,
      last_from        TEXT,
      last_to          TEXT,
      last_snippet     TEXT,
      message_count    INTEGER,
      last_message_at  TEXT,
      label_ids        TEXT,
      synced_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gmail_sync_runs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at        TEXT NOT NULL,
      finished_at       TEXT,
      kind              TEXT NOT NULL DEFAULT 'incremental',
      threads_seen      INTEGER NOT NULL DEFAULT 0,
      threads_inserted  INTEGER NOT NULL DEFAULT 0,
      threads_updated   INTEGER NOT NULL DEFAULT 0,
      threads_fetched   INTEGER NOT NULL DEFAULT 0,
      errors_json       TEXT
    );

    CREATE TABLE IF NOT EXISTS gmail_api_usage (
      date               TEXT PRIMARY KEY,
      calls_succeeded    INTEGER NOT NULL DEFAULT 0,
      calls_failed       INTEGER NOT NULL DEFAULT 0,
      calls_rate_limited INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gmail_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  const ensureColumn = (column: string, type: string) => {
    if (!hasColumn(db, "gmail_drafts", column)) {
      db.exec(`ALTER TABLE gmail_drafts ADD COLUMN ${column} ${type}`)
    }
  }
  ensureColumn("output_id", "TEXT")
  ensureColumn("error_message", "TEXT")
  ensureColumn("updated_at", "TEXT NOT NULL DEFAULT (datetime('now'))")
  ensureColumn("sent_at", "TEXT")
  ensureColumn("gmail_thread_id", "TEXT")

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gmail_drafts_status ON gmail_drafts(status);
    CREATE INDEX IF NOT EXISTS idx_gmail_drafts_output_id ON gmail_drafts(output_id);
    CREATE INDEX IF NOT EXISTS idx_gmail_jobs_status_run_at ON gmail_jobs(status, run_at);
    CREATE INDEX IF NOT EXISTS idx_gmail_threads_last_at ON gmail_threads(last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gmail_threads_subject ON gmail_threads(subject);
    CREATE INDEX IF NOT EXISTS idx_gmail_sync_runs_started ON gmail_sync_runs(started_at DESC);
  `)
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}
