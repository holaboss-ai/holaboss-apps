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

// Copies pre-rename `posts` / `jobs` rows out of the per-app private file
// at ./data/module.db (legacy layout) into the workspace-shared db's
// namespaced tables. Renames the source file to *.bak afterwards so the
// migration is one-shot. Idempotent — bails out if the shared db already
// has reddit_posts.
function migrateLegacyPrivateDb(sharedDb: Database.Database): void {
  const legacyPath = path.join(process.cwd(), "data", "module.db")
  if (!existsSync(legacyPath)) return

  const sharedHasPosts = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reddit_posts'")
    .get()
  if (sharedHasPosts) return

  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHasPosts = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='posts'")
      .get()
    if (legacyHasPosts) {
      sharedDb.exec("CREATE TABLE reddit_posts AS SELECT * FROM legacy.posts")
    }
    const legacyHasJobs = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='jobs'")
      .get()
    if (legacyHasJobs) {
      sharedDb.exec("CREATE TABLE reddit_jobs AS SELECT * FROM legacy.jobs")
    }
  } finally {
    sharedDb.exec("DETACH DATABASE legacy")
  }

  renameSync(legacyPath, `${legacyPath}.bak`)
}

// In-place upgrade for the legacy direct-file path (e.g. tests pointing
// DB_PATH at a fresh file pre-dating the rename). SQLite's
// ALTER TABLE RENAME preserves rows and indexes.
function renameLegacyTablesIfNeeded(db: Database.Database): void {
  const renameIfNeeded = (oldName: string, newName: string) => {
    const oldExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(oldName)
    const newExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(newName)
    if (oldExists && !newExists) {
      db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`)
    }
  }
  renameIfNeeded("posts", "reddit_posts")
  renameIfNeeded("jobs", "reddit_jobs")
}

// Schema spans three concerns:
//
// 1. Drafting + queueing existing-style posts (reddit_posts, reddit_jobs)
//    — author-then-publish flow inherited from the original app design.
// 2. Tracked posts: external Reddit URLs the user hands us so we monitor
//    upvote / engagement on a fixed 4h × 12 schedule for 48h. Stored in
//    the SAME reddit_posts row but distinguished by `source_url` being
//    set + `monitoring_started_at` being set.
// 3. Metrics tables (snapshots / runs / api_usage / settings) following
//    the cross-platform convention in
//    holaOS/docs/plans/2026-04-28-post-metrics-convention.md.
function ensureSchema(db: Database.Database): void {
  // Step 1 — tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reddit_posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      subreddit TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      output_id TEXT,
      external_post_id TEXT,
      scheduled_at TEXT,
      published_at TEXT,
      error_message TEXT,
      source_url TEXT,
      monitoring_started_at TEXT,
      monitoring_completed_at TEXT,
      final_score INTEGER,
      final_num_comments INTEGER,
      final_upvote_ratio REAL,
      views INTEGER,
      deleted_at TEXT,
      deleted_reason TEXT,
      deleted_reason_raw TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reddit_jobs (
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

    -- Each captured-at row is a single milestone tick. PK enforces
    -- one-per-minute uniqueness; we round captured_at to the minute
    -- so accidental near-double fires don't insert duplicate rows.
    -- comments alias kept for the cross-app convention; for Reddit
    -- it stores num_comments. score is reddit's "upvotes" and
    -- upvote_ratio its sentiment metric.
    CREATE TABLE IF NOT EXISTS reddit_post_metrics (
      post_id        TEXT NOT NULL,
      captured_at    TEXT NOT NULL,
      score          INTEGER,
      num_comments   INTEGER,
      upvote_ratio   REAL,
      milestone_idx  INTEGER,
      raw            TEXT,
      PRIMARY KEY (post_id, captured_at)
    );

    -- Reddit doesn't use a daily rollup the way Twitter does (the
    -- 12-snapshot lifecycle is short enough that raw rows survive for
    -- the entire monitoring window). Table kept for symmetry with the
    -- convention so cross-platform dashboards UNION cleanly.
    CREATE TABLE IF NOT EXISTS reddit_post_metrics_daily (
      post_id      TEXT NOT NULL,
      day          TEXT NOT NULL,
      score        INTEGER,
      num_comments INTEGER,
      upvote_ratio REAL,
      PRIMARY KEY (post_id, day)
    );

    CREATE TABLE IF NOT EXISTS reddit_metrics_runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at       TEXT NOT NULL,
      finished_at      TEXT,
      kind             TEXT NOT NULL DEFAULT 'refresh',
      posts_considered INTEGER NOT NULL DEFAULT 0,
      posts_refreshed  INTEGER NOT NULL DEFAULT 0,
      posts_skipped    INTEGER NOT NULL DEFAULT 0,
      posts_deleted    INTEGER NOT NULL DEFAULT 0,
      posts_completed  INTEGER NOT NULL DEFAULT 0,
      errors_json      TEXT
    );

    CREATE TABLE IF NOT EXISTS reddit_api_usage (
      date               TEXT PRIMARY KEY,
      calls_succeeded    INTEGER NOT NULL DEFAULT 0,
      calls_failed       INTEGER NOT NULL DEFAULT 0,
      calls_rate_limited INTEGER NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reddit_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Step 2 — column backfill for tables that may pre-date columns.
  const ensureColumn = (column: string, type: string) => {
    if (!hasColumn(db, "reddit_posts", column)) {
      db.exec(`ALTER TABLE reddit_posts ADD COLUMN ${column} ${type}`)
    }
  }
  ensureColumn("output_id", "TEXT")
  ensureColumn("external_post_id", "TEXT")
  ensureColumn("scheduled_at", "TEXT")
  ensureColumn("published_at", "TEXT")
  ensureColumn("error_message", "TEXT")
  ensureColumn("source_url", "TEXT")
  ensureColumn("monitoring_started_at", "TEXT")
  ensureColumn("monitoring_completed_at", "TEXT")
  ensureColumn("final_score", "INTEGER")
  ensureColumn("final_num_comments", "INTEGER")
  ensureColumn("final_upvote_ratio", "REAL")
  ensureColumn("views", "INTEGER")
  ensureColumn("deleted_at", "TEXT")
  ensureColumn("deleted_reason", "TEXT")
  ensureColumn("deleted_reason_raw", "TEXT")

  // Step 3 — indexes.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reddit_posts_status ON reddit_posts(status);
    CREATE INDEX IF NOT EXISTS idx_reddit_posts_created_at ON reddit_posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_reddit_posts_output_id ON reddit_posts(output_id);
    CREATE INDEX IF NOT EXISTS idx_reddit_posts_monitoring
      ON reddit_posts(monitoring_started_at)
      WHERE source_url IS NOT NULL
        AND deleted_at IS NULL
        AND monitoring_completed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_reddit_jobs_status_run_at ON reddit_jobs(status, run_at);
    CREATE INDEX IF NOT EXISTS idx_reddit_post_metrics_captured
      ON reddit_post_metrics(captured_at);
    CREATE INDEX IF NOT EXISTS idx_reddit_metrics_runs_started
      ON reddit_metrics_runs(started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reddit_posts_source_url
      ON reddit_posts(source_url)
      WHERE source_url IS NOT NULL;
  `)
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}
