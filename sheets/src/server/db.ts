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
  }

  renameLegacyTablesIfNeeded(db)
  ensureSchema(db)
  return db
}

function migrateLegacyPrivateDb(sharedDb: Database.Database): void {
  const legacyPath = path.join(process.cwd(), "data", "module.db")
  if (!existsSync(legacyPath)) return
  const sharedHas = sharedDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sheets_sync_state'")
    .get()
  if (sharedHas) return
  const escaped = legacyPath.replace(/'/g, "''")
  sharedDb.exec(`ATTACH DATABASE '${escaped}' AS legacy`)
  try {
    const legacyHas = sharedDb
      .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name='sync_state'")
      .get()
    if (legacyHas) sharedDb.exec("CREATE TABLE sheets_sync_state AS SELECT * FROM legacy.sync_state")
  } finally {
    sharedDb.exec("DETACH DATABASE legacy")
  }
  renameSync(legacyPath, `${legacyPath}.bak`)
}

function renameLegacyTablesIfNeeded(db: Database.Database): void {
  const oldExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_state'")
    .get()
  const newExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sheets_sync_state'")
    .get()
  if (oldExists && !newExists) {
    db.exec("ALTER TABLE sync_state RENAME TO sheets_sync_state")
  }
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sheets_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}
