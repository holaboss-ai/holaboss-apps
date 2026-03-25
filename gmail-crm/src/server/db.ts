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
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      company TEXT,
      stage TEXT NOT NULL DEFAULT 'lead',
      notes TEXT,
      tags TEXT,
      sheet_row_number INTEGER,
      last_contact_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage);

    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      gmail_thread_id TEXT,
      gmail_message_id TEXT,
      subject TEXT,
      snippet TEXT,
      direction TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      gmail_thread_id TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}
