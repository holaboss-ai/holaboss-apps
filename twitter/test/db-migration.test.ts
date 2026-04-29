import Database from "better-sqlite3"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ORIGINAL_ENV = {
  WORKSPACE_DB_PATH: process.env.WORKSPACE_DB_PATH,
  DB_PATH: process.env.DB_PATH,
}

let scratchDir = ""
let prevCwd = ""

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "twitter-db-migration-"))
  prevCwd = process.cwd()
  process.chdir(scratchDir)
  delete process.env.WORKSPACE_DB_PATH
  delete process.env.DB_PATH
  vi.resetModules()
})

afterEach(() => {
  process.chdir(prevCwd)
  rmSync(scratchDir, { recursive: true, force: true })
  if (ORIGINAL_ENV.WORKSPACE_DB_PATH === undefined) {
    delete process.env.WORKSPACE_DB_PATH
  } else {
    process.env.WORKSPACE_DB_PATH = ORIGINAL_ENV.WORKSPACE_DB_PATH
  }
  if (ORIGINAL_ENV.DB_PATH === undefined) {
    delete process.env.DB_PATH
  } else {
    process.env.DB_PATH = ORIGINAL_ENV.DB_PATH
  }
})

function seedLegacyDb(filePath: string, rows: { posts?: number; jobs?: number } = {}) {
  const db = new Database(filePath)
  db.pragma("journal_mode = WAL")
  db.exec(`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      run_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const now = "2026-04-28T12:00:00.000Z"
  const insertPost = db.prepare(
    "INSERT INTO posts (id, content, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)",
  )
  for (let i = 0; i < (rows.posts ?? 0); i += 1) {
    insertPost.run(`post-${i}`, `Tweet ${i}`, now, now)
  }
  const insertJob = db.prepare(
    "INSERT INTO jobs (id, type, payload, status, run_at, created_at, updated_at) VALUES (?, 'publish', ?, 'waiting', ?, ?, ?)",
  )
  for (let i = 0; i < (rows.jobs ?? 0); i += 1) {
    insertJob.run(`job-${i}`, JSON.stringify({ post_id: `post-${i}` }), now, now, now)
  }
  db.close()
}

describe("twitter db migration", () => {
  it("renames legacy `posts`/`jobs` tables in place when using a direct DB_PATH", async () => {
    const dbFile = join(scratchDir, "module.db")
    seedLegacyDb(dbFile, { posts: 3, jobs: 2 })
    process.env.DB_PATH = dbFile

    const { getDb } = await import("../src/server/db")
    const db = getDb()

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain("twitter_posts")
    expect(names).toContain("twitter_jobs")
    expect(names).not.toContain("posts")
    expect(names).not.toContain("jobs")

    const postCount = (db.prepare("SELECT COUNT(*) AS c FROM twitter_posts").get() as { c: number }).c
    const jobCount = (db.prepare("SELECT COUNT(*) AS c FROM twitter_jobs").get() as { c: number }).c
    expect(postCount).toBe(3)
    expect(jobCount).toBe(2)
    db.close()
  })

  it("copies legacy ./data/module.db rows into the workspace-shared db and backs up the old file", async () => {
    const legacyDir = join(scratchDir, "data")
    const legacyPath = join(legacyDir, "module.db")
    mkdirSync(legacyDir, { recursive: true })
    seedLegacyDb(legacyPath, { posts: 2, jobs: 1 })

    const sharedPath = join(scratchDir, ".holaboss", "data.db")
    process.env.WORKSPACE_DB_PATH = sharedPath

    const { getDb } = await import("../src/server/db")
    const db = getDb()

    const postCount = (db.prepare("SELECT COUNT(*) AS c FROM twitter_posts").get() as { c: number }).c
    const jobCount = (db.prepare("SELECT COUNT(*) AS c FROM twitter_jobs").get() as { c: number }).c
    expect(postCount).toBe(2)
    expect(jobCount).toBe(1)

    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(`${legacyPath}.bak`)).toBe(true)
    db.close()
  })

  it("ensures schema on a fresh shared db with no legacy data", async () => {
    const sharedPath = join(scratchDir, ".holaboss", "data.db")
    process.env.WORKSPACE_DB_PATH = sharedPath

    const { getDb } = await import("../src/server/db")
    const db = getDb()

    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(names).toContain("twitter_posts")
    expect(names).toContain("twitter_jobs")
    expect(names).toContain("twitter_post_metrics")
    expect(names).toContain("twitter_post_metrics_daily")
    expect(names).toContain("twitter_metrics_runs")
    expect(names).toContain("twitter_api_usage")

    // twitter_posts gets the deleted_at column on fresh init.
    const postCols = (
      db.prepare("PRAGMA table_info(twitter_posts)").all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(postCols).toContain("deleted_at")

    // Indexes recreated against the new names.
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((i) => i.name)
    expect(indexes).toContain("idx_twitter_posts_status")
    expect(indexes).toContain("idx_twitter_jobs_status_run_at")
    expect(indexes).toContain("idx_twitter_post_metrics_captured")
    expect(indexes).toContain("idx_twitter_metrics_runs_started")
    db.close()
  })

  it("backfills deleted_at column on a pre-existing twitter_posts table", async () => {
    const sharedPath = join(scratchDir, ".holaboss", "data.db")
    process.env.WORKSPACE_DB_PATH = sharedPath
    // Seed a "pre-deleted_at" twitter_posts table inline so we exercise
    // the ALTER-on-second-init path explicitly. Mirrors what the
    // post-rename migration would have produced before this commit.
    mkdirSync(join(scratchDir, ".holaboss"), { recursive: true })
    {
      const seed = new Database(sharedPath)
      seed.exec(`
        CREATE TABLE twitter_posts (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          output_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      seed.prepare(
        "INSERT INTO twitter_posts (id, content, status, created_at, updated_at) VALUES (?, ?, 'published', ?, ?)",
      ).run("p1", "x", "2026-04-01T00:00:00Z", "2026-04-01T00:00:00Z")
      seed.close()
    }

    const { getDb } = await import("../src/server/db")
    const db = getDb()
    const cols = (
      db.prepare("PRAGMA table_info(twitter_posts)").all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain("deleted_at")
    const row = db.prepare("SELECT id, deleted_at FROM twitter_posts WHERE id = 'p1'").get() as {
      id: string
      deleted_at: string | null
    }
    expect(row.deleted_at).toBeNull()
    db.close()
  })
})
