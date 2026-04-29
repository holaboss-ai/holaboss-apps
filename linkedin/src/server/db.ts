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
  const sharedHasPosts = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='linkedin_posts'")
    .get()
  if (sharedHasPosts) return
  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHasPosts = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='posts'")
      .get()
    if (legacyHasPosts) sharedDb.exec("CREATE TABLE linkedin_posts AS SELECT * FROM legacy.posts")
    const legacyHasJobs = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='jobs'")
      .get()
    if (legacyHasJobs) sharedDb.exec("CREATE TABLE linkedin_jobs AS SELECT * FROM legacy.jobs")
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
  renameIfNeeded("posts", "linkedin_posts")
  renameIfNeeded("jobs", "linkedin_jobs")
}

function ensureSchema(db: Database.Database): void {
  // Schema follows the cross-platform metrics convention documented in
  // holaOS/docs/plans/2026-04-28-post-metrics-convention.md. Same shape
  // as twitter's so dashboards UNION cleanly across platforms.
  db.exec(`
    CREATE TABLE IF NOT EXISTS linkedin_posts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      output_id TEXT,
      external_post_id TEXT,
      scheduled_at TEXT,
      published_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS linkedin_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'publish',
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS linkedin_post_metrics (
      post_id     TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      impressions INTEGER,
      likes       INTEGER,
      comments    INTEGER,
      shares      INTEGER,
      raw         TEXT,
      PRIMARY KEY (post_id, captured_at)
    );

    CREATE TABLE IF NOT EXISTS linkedin_post_metrics_daily (
      post_id     TEXT NOT NULL,
      day         TEXT NOT NULL,
      impressions INTEGER,
      likes       INTEGER,
      comments    INTEGER,
      shares      INTEGER,
      PRIMARY KEY (post_id, day)
    );

    CREATE TABLE IF NOT EXISTS linkedin_metrics_runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at       TEXT NOT NULL,
      finished_at      TEXT,
      kind             TEXT NOT NULL DEFAULT 'refresh',
      posts_considered INTEGER NOT NULL DEFAULT 0,
      posts_refreshed  INTEGER NOT NULL DEFAULT 0,
      posts_skipped    INTEGER NOT NULL DEFAULT 0,
      posts_deleted    INTEGER NOT NULL DEFAULT 0,
      errors_json      TEXT
    );

    CREATE TABLE IF NOT EXISTS linkedin_api_usage (
      date               TEXT PRIMARY KEY,
      calls_succeeded    INTEGER NOT NULL DEFAULT 0,
      calls_failed       INTEGER NOT NULL DEFAULT 0,
      calls_rate_limited INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS linkedin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  const ensureColumn = (column: string, type: string) => {
    if (!hasColumn(db, "linkedin_posts", column)) {
      db.exec(`ALTER TABLE linkedin_posts ADD COLUMN ${column} ${type}`)
    }
  }
  ensureColumn("output_id", "TEXT")
  ensureColumn("external_post_id", "TEXT")
  ensureColumn("scheduled_at", "TEXT")
  ensureColumn("published_at", "TEXT")
  ensureColumn("error_message", "TEXT")
  // Set when LinkedIn API returns 404 / 410 for a post we've been
  // tracking — keeps the row + historical metrics, stops refresh.
  ensureColumn("deleted_at", "TEXT")

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_linkedin_posts_status ON linkedin_posts(status);
    CREATE INDEX IF NOT EXISTS idx_linkedin_posts_created_at ON linkedin_posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_linkedin_posts_output_id ON linkedin_posts(output_id);
    CREATE INDEX IF NOT EXISTS idx_linkedin_posts_published_at
      ON linkedin_posts(published_at)
      WHERE status = 'published' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_linkedin_jobs_status_run_at ON linkedin_jobs(status, run_at);
    CREATE INDEX IF NOT EXISTS idx_linkedin_post_metrics_captured
      ON linkedin_post_metrics(captured_at);
    CREATE INDEX IF NOT EXISTS idx_linkedin_metrics_runs_started
      ON linkedin_metrics_runs(started_at DESC);
  `)
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}
