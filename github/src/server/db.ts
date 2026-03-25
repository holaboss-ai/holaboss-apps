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
  return db
}
