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
  ensureSchemaFallback(db)
  return db
}

// Copies pre-rename `posts` / `jobs` rows out of the per-app private file
// at ./data/module.db (legacy layout) into the workspace-shared db's
// namespaced tables. Renames the source file to *.bak afterwards so the
// migration is one-shot. Idempotent — bails out if the shared db already
// has twitter_posts.
function migrateLegacyPrivateDb(sharedDb: Database.Database): void {
  const legacyPath = path.join(process.cwd(), "data", "module.db")
  if (!existsSync(legacyPath)) return

  const sharedHasPosts = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='twitter_posts'")
    .get()
  if (sharedHasPosts) return

  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHasPosts = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='posts'")
      .get()
    if (legacyHasPosts) {
      sharedDb.exec("CREATE TABLE twitter_posts AS SELECT * FROM legacy.posts")
    }
    const legacyHasJobs = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='jobs'")
      .get()
    if (legacyHasJobs) {
      sharedDb.exec("CREATE TABLE twitter_jobs AS SELECT * FROM legacy.jobs")
    }
  } finally {
    sharedDb.exec("DETACH DATABASE legacy")
  }

  renameSync(legacyPath, `${legacyPath}.bak`)
}

// In-place upgrade for the legacy direct-file path (e.g. tests pointing
// DB_PATH at a fresh file pre-dating the rename, or fixtures still using
// the old names). SQLite's ALTER TABLE RENAME preserves rows and indexes.
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
  renameIfNeeded("posts", "twitter_posts")
  renameIfNeeded("jobs", "twitter_jobs")
}

// Schema is now owned by the runtime (Tier 2 of the workspace data
// layer plan). The runtime parses `data_schema:` from app.runtime.yaml
// and runs CREATE TABLE / ALTER TABLE before this process spawns, so
// getDb() opens a database whose tables already exist.
//
// We still call ensureSchemaFallback() as a safety net for the case
// where someone runs this app standalone (e.g. `npm run dev`) outside
// a Holaboss workspace, or under an older runtime that doesn't yet
// understand `data_schema:`. The shape it creates matches the
// manifest exactly. Once Tier 2 is the only supported runtime path
// we can delete this function entirely.
function ensureSchemaFallback(db: Database.Database): void {
  // Step 1 — tables. Each is CREATE TABLE IF NOT EXISTS so re-running
  // against a Tier 2-managed DB is a no-op.
  db.exec(`
    CREATE TABLE IF NOT EXISTS twitter_posts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      output_id TEXT,
      external_post_id TEXT,
      scheduled_at TEXT,
      published_at TEXT,
      deleted_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS twitter_jobs (
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
    CREATE TABLE IF NOT EXISTS twitter_post_metrics (
      post_id TEXT NOT NULL, captured_at TEXT NOT NULL,
      impressions INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, bookmarks INTEGER,
      raw TEXT, PRIMARY KEY (post_id, captured_at)
    );
    CREATE TABLE IF NOT EXISTS twitter_post_metrics_daily (
      post_id TEXT NOT NULL, day TEXT NOT NULL,
      impressions INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, bookmarks INTEGER,
      PRIMARY KEY (post_id, day)
    );
    CREATE TABLE IF NOT EXISTS twitter_metrics_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
      kind TEXT NOT NULL DEFAULT 'refresh',
      posts_considered INTEGER NOT NULL DEFAULT 0, posts_refreshed INTEGER NOT NULL DEFAULT 0,
      posts_skipped INTEGER NOT NULL DEFAULT 0, posts_deleted INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT
    );
    CREATE TABLE IF NOT EXISTS twitter_api_usage (
      date TEXT PRIMARY KEY,
      calls_succeeded INTEGER NOT NULL DEFAULT 0, calls_failed INTEGER NOT NULL DEFAULT 0,
      calls_rate_limited INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS twitter_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Step 2 — backfill columns that a pre-Tier-2 in-place migration may
  // have skipped. Each ALTER is gated by a PRAGMA check. Must run
  // before the indexes below because some of them reference these
  // columns. Tier 2 runtime applies these via the data_schema diff
  // before this fallback runs, so this is only load-bearing for
  // standalone (npm run dev) and pre-Tier-2 setups.
  for (const [column, type] of [
    ["output_id", "TEXT"],
    ["external_post_id", "TEXT"],
    ["scheduled_at", "TEXT"],
    ["published_at", "TEXT"],
    ["error_message", "TEXT"],
    ["deleted_at", "TEXT"],
  ] as const) {
    if (!hasColumn(db, "twitter_posts", column)) {
      db.exec(`ALTER TABLE twitter_posts ADD COLUMN ${column} ${type}`)
    }
  }

  // Step 3 — indexes. Safe now that all referenced columns exist.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_twitter_posts_status ON twitter_posts(status);
    CREATE INDEX IF NOT EXISTS idx_twitter_posts_created_at ON twitter_posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_twitter_posts_output_id ON twitter_posts(output_id);
    CREATE INDEX IF NOT EXISTS idx_twitter_posts_published_at
      ON twitter_posts(published_at)
      WHERE status = 'published' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_twitter_jobs_status_run_at ON twitter_jobs(status, run_at);
    CREATE INDEX IF NOT EXISTS idx_twitter_post_metrics_captured ON twitter_post_metrics(captured_at);
    CREATE INDEX IF NOT EXISTS idx_twitter_metrics_runs_started ON twitter_metrics_runs(started_at);
  `)
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}
