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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_linkedin_posts_status ON linkedin_posts(status);
    CREATE INDEX IF NOT EXISTS idx_linkedin_posts_created_at ON linkedin_posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_linkedin_posts_output_id ON linkedin_posts(output_id);
    CREATE INDEX IF NOT EXISTS idx_linkedin_jobs_status_run_at ON linkedin_jobs(status, run_at);
  `)
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}
