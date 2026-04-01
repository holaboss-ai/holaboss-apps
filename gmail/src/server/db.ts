import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import path from "node:path"

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "module.db")
  mkdirSync(path.dirname(dbPath), { recursive: true })
  db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  migrate(db)
  return db
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      to_email TEXT NOT NULL,
      gmail_thread_id TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      output_id TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_output_id ON drafts(output_id);
  `)

  if (!hasColumn(db, "drafts", "output_id")) {
    db.exec("ALTER TABLE drafts ADD COLUMN output_id TEXT")
  }
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}
