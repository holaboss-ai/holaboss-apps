import Database from "better-sqlite3"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const proxyMock = vi.fn()
vi.mock("../src/server/holaboss-bridge", () => ({
  createIntegrationClient: () => ({ proxy: proxyMock }),
}))

const ORIGINAL_ENV = {
  WORKSPACE_DB_PATH: process.env.WORKSPACE_DB_PATH,
  DB_PATH: process.env.DB_PATH,
}

let scratchDir = ""
let prevCwd = ""

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "reddit-metrics-"))
  prevCwd = process.cwd()
  process.chdir(scratchDir)
  delete process.env.WORKSPACE_DB_PATH
  process.env.DB_PATH = join(scratchDir, "test.db")
  vi.resetModules()
  proxyMock.mockReset()
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

function seedTrackedPost(overrides: {
  id?: string
  subreddit?: string
  external_post_id?: string
  monitoring_started_at: string
  monitoring_completed_at?: string | null
  deleted_at?: string | null
  source_url?: string
} = { monitoring_started_at: new Date().toISOString() }) {
  const dbPath = join(scratchDir, "test.db")
  mkdirSync(scratchDir, { recursive: true })
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
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
  `)
  db.prepare(
    `INSERT INTO reddit_posts
       (id, title, subreddit, status, external_post_id, source_url,
        monitoring_started_at, monitoring_completed_at, deleted_at)
     VALUES (?, '', ?, 'published', ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id ?? "p1",
    overrides.subreddit ?? "programming",
    overrides.external_post_id ?? "abc123",
    overrides.source_url ?? "https://www.reddit.com/r/programming/comments/abc123/",
    overrides.monitoring_started_at,
    overrides.monitoring_completed_at ?? null,
    overrides.deleted_at ?? null,
  )
  db.close()
}

describe("currentMilestone", () => {
  it("buckets monitoring age into 12 four-hour slots, then null after 48h", async () => {
    const { currentMilestone } = await import("../src/server/metrics")
    const start = new Date("2026-04-29T00:00:00Z")
    const at = (h: number) =>
      new Date(start.getTime() + h * 60 * 60 * 1000)
    expect(currentMilestone(start, at(0))).toBe(0)
    expect(currentMilestone(start, at(3.9))).toBe(0)
    expect(currentMilestone(start, at(4))).toBe(1)
    expect(currentMilestone(start, at(20))).toBe(5)
    expect(currentMilestone(start, at(44))).toBe(11)
    expect(currentMilestone(start, at(47.99))).toBe(11)
    expect(currentMilestone(start, at(48))).toBeNull()
    expect(currentMilestone(start, at(72))).toBeNull()
  })
})

describe("isMilestoneDue", () => {
  it("returns due once per 4h slot; not due if same slot already captured", async () => {
    const { isMilestoneDue } = await import("../src/server/metrics")
    const start = new Date("2026-04-29T00:00:00Z")
    const now = new Date(start.getTime() + 5 * 60 * 60 * 1000) // 5h in → milestone 1

    // Never captured → due, milestoneIdx=1
    let r = isMilestoneDue(start, null, null, now, false)
    expect(r.due).toBe(true)
    expect(r.milestoneIdx).toBe(1)

    // Captured already at milestone 1 → not due
    r = isMilestoneDue(
      start,
      new Date(start.getTime() + 4.2 * 60 * 60 * 1000).toISOString(),
      1,
      now,
      false,
    )
    expect(r.due).toBe(false)

    // Last captured at milestone 0; we're now in 1 → due
    r = isMilestoneDue(
      start,
      new Date(start.getTime() + 0.5 * 60 * 60 * 1000).toISOString(),
      0,
      now,
      false,
    )
    expect(r.due).toBe(true)
    expect(r.milestoneIdx).toBe(1)
  })

  it("force=true bypasses milestone gate but still computes the slot", async () => {
    const { isMilestoneDue } = await import("../src/server/metrics")
    const start = new Date("2026-04-29T00:00:00Z")
    const now = new Date(start.getTime() + 5 * 60 * 60 * 1000)
    const r = isMilestoneDue(
      start,
      new Date(start.getTime() + 4.5 * 60 * 60 * 1000).toISOString(),
      1,
      now,
      true,
    )
    expect(r.due).toBe(true)
    expect(r.milestoneIdx).toBe(1)
  })

  it("after 48h returns due=false (post should transition to completed)", async () => {
    const { isMilestoneDue } = await import("../src/server/metrics")
    const start = new Date("2026-04-29T00:00:00Z")
    const now = new Date(start.getTime() + 50 * 60 * 60 * 1000)
    expect(isMilestoneDue(start, null, null, now, false).due).toBe(false)
  })
})

describe("refreshPostMetrics — captures snapshot at current milestone", () => {
  it("inserts a snapshot row when post is due", async () => {
    const startedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 min ago → milestone 0
    seedTrackedPost({ monitoring_started_at: startedAt })

    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                id: "abc123",
                score: 42,
                num_comments: 8,
                upvote_ratio: 0.95,
                subreddit: "programming",
                title: "Test post",
              },
            },
          ],
        },
      },
      headers: {},
    })

    const { refreshPostMetrics } = await import("../src/server/metrics")
    const { getDb } = await import("../src/server/db")
    const result = await refreshPostMetrics({})
    expect(result.posts_refreshed).toBe(1)
    expect(result.posts_completed).toBe(0)

    const snap = getDb()
      .prepare(
        "SELECT post_id, score, num_comments, upvote_ratio, milestone_idx FROM reddit_post_metrics",
      )
      .all() as Array<{
      post_id: string
      score: number
      num_comments: number
      upvote_ratio: number
      milestone_idx: number
    }>
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({
      post_id: "p1",
      score: 42,
      num_comments: 8,
      upvote_ratio: 0.95,
      milestone_idx: 0,
    })
    getDb().close()
  })
})

describe("refreshPostMetrics — deletion handling", () => {
  it("marks deleted_at + normalized reason when removed_by_category is moderator", async () => {
    seedTrackedPost({
      monitoring_started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    })
    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                id: "abc123",
                score: 5,
                num_comments: 0,
                upvote_ratio: 0.5,
                removed_by_category: "moderator",
              },
            },
          ],
        },
      },
      headers: {},
    })

    const { refreshPostMetrics } = await import("../src/server/metrics")
    const { getDb } = await import("../src/server/db")
    const result = await refreshPostMetrics({})
    expect(result.posts_deleted).toBe(1)

    const post = getDb()
      .prepare(
        "SELECT deleted_at, deleted_reason, deleted_reason_raw FROM reddit_posts WHERE id = 'p1'",
      )
      .get() as {
      deleted_at: string | null
      deleted_reason: string | null
      deleted_reason_raw: string | null
    }
    expect(post.deleted_at).not.toBeNull()
    expect(post.deleted_reason).toBe("mod_removed")
    expect(post.deleted_reason_raw).toBe("moderator")
    getDb().close()
  })

  it("treats absent-from-response as 'not_found' deletion", async () => {
    seedTrackedPost({
      monitoring_started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    })
    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: { data: { children: [] } },
      headers: {},
    })

    const { refreshPostMetrics } = await import("../src/server/metrics")
    const { getDb } = await import("../src/server/db")
    const result = await refreshPostMetrics({})
    expect(result.posts_deleted).toBe(1)
    const post = getDb()
      .prepare(
        "SELECT deleted_reason, deleted_reason_raw FROM reddit_posts WHERE id = 'p1'",
      )
      .get() as { deleted_reason: string | null; deleted_reason_raw: string | null }
    expect(post.deleted_reason).toBe("unknown")
    expect(post.deleted_reason_raw).toBe("not_found")
    getDb().close()
  })
})

describe("refreshPostMetrics — 48h freeze", () => {
  it("locks final values from the last snapshot when the window expires", async () => {
    const startedAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString()
    seedTrackedPost({ monitoring_started_at: startedAt })

    // Pre-populate one snapshot so the freeze step can copy from it.
    const dbPath = join(scratchDir, "test.db")
    const seedDb = new Database(dbPath)
    seedDb.exec(`
      CREATE TABLE IF NOT EXISTS reddit_post_metrics (
        post_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        score INTEGER, num_comments INTEGER, upvote_ratio REAL,
        milestone_idx INTEGER, raw TEXT,
        PRIMARY KEY (post_id, captured_at)
      );
    `)
    seedDb
      .prepare(
        "INSERT INTO reddit_post_metrics (post_id, captured_at, score, num_comments, upvote_ratio, milestone_idx) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "2026-04-29T11:00:00.000Z", 250, 35, 0.92, 11)
    seedDb.close()

    const { refreshPostMetrics } = await import("../src/server/metrics")
    const { getDb } = await import("../src/server/db")
    const result = await refreshPostMetrics({})
    expect(result.posts_completed).toBe(1)
    expect(result.posts_refreshed).toBe(0)

    const post = getDb()
      .prepare(
        "SELECT monitoring_completed_at, final_score, final_num_comments, final_upvote_ratio FROM reddit_posts WHERE id = 'p1'",
      )
      .get() as {
      monitoring_completed_at: string | null
      final_score: number | null
      final_num_comments: number | null
      final_upvote_ratio: number | null
    }
    expect(post.monitoring_completed_at).not.toBeNull()
    expect(post.final_score).toBe(250)
    expect(post.final_num_comments).toBe(35)
    expect(post.final_upvote_ratio).toBe(0.92)
    getDb().close()
  })
})
