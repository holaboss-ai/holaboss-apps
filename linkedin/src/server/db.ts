import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import path from "node:path"

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "module.db")
  const dir = path.dirname(dbPath)
  mkdirSync(dir, { recursive: true })

  db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")

  migrate(db)
  return db
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
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

    CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
    CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_posts_output_id ON posts(output_id);

    CREATE TABLE IF NOT EXISTS jobs (
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

    CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, run_at);
  `)

  if (!hasColumn(db, "posts", "output_id")) {
    db.exec("ALTER TABLE posts ADD COLUMN output_id TEXT")
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}
