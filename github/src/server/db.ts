import { getWorkspaceDb } from "@holaboss/bridge"
import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import path from "node:path"

let db: Database.Database | null = null

// GitHub app is currently read-through against the GitHub API and
// doesn't write any tables of its own. Wiring up getWorkspaceDb()
// keeps the app on the cross-app convention: file location is
// uniform and a future github_repo_metrics / github_pr_events table
// (e.g. for dev-rel monitoring) can land here without further
// plumbing.
export function getDb(): Database.Database {
  if (db) return db
  if (process.env.WORKSPACE_DB_PATH) {
    db = getWorkspaceDb() as unknown as Database.Database
  } else {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "module.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    db = new Database(dbPath)
    db.pragma("journal_mode = WAL")
  }
  return db
}
