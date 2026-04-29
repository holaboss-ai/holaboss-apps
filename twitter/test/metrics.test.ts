import Database from "better-sqlite3"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the Composio bridge so tests don't hit the network. The mock is
// returned via createIntegrationClient(); each test installs a fresh
// proxy fn before calling refreshPostMetrics.
const proxyMock = vi.fn()
vi.mock("../src/server/holaboss-bridge", () => ({
  createIntegrationClient: () => ({
    proxy: proxyMock,
  }),
  // The real shim exports more, but only createIntegrationClient is
  // used inside metrics.ts.
}))

const ORIGINAL_ENV = {
  WORKSPACE_DB_PATH: process.env.WORKSPACE_DB_PATH,
  DB_PATH: process.env.DB_PATH,
}

let scratchDir = ""
let prevCwd = ""

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "twitter-metrics-"))
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

function seedPosts(rows: Array<{
  id: string
  external_post_id: string
  status: string
  published_at: string | null
  deleted_at?: string | null
}>): void {
  const dbPath = join(scratchDir, "test.db")
  mkdirSync(scratchDir, { recursive: true })
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  // Mirror twitter app's CREATE TABLE so getDb's IF NOT EXISTS leaves
  // it alone afterwards. Includes deleted_at upfront.
  db.exec(`
    CREATE TABLE twitter_posts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      output_id TEXT,
      external_post_id TEXT,
      scheduled_at TEXT,
      published_at TEXT,
      error_message TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  const insert = db.prepare(
    `INSERT INTO twitter_posts (id, content, status, external_post_id, published_at, deleted_at)
     VALUES (?, '', ?, ?, ?, ?)`,
  )
  for (const r of rows) {
    insert.run(
      r.id,
      r.status,
      r.external_post_id,
      r.published_at,
      r.deleted_at ?? null,
    )
  }
  db.close()
}

describe("tierFor", () => {
  it("buckets posts by age", async () => {
    const { tierFor } = await import("../src/server/metrics")
    const now = new Date("2026-04-28T12:00:00Z")
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000)
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000)

    expect(tierFor(minutesAgo(10), now).tier).toBe("active")
    expect(tierFor(minutesAgo(10), now).intervalMs).toBe(5 * 60_000)

    expect(tierFor(minutesAgo(120), now).tier).toBe("settling")
    expect(tierFor(minutesAgo(120), now).intervalMs).toBe(30 * 60_000)

    expect(tierFor(daysAgo(3), now).tier).toBe("weekly")
    expect(tierFor(daysAgo(3), now).intervalMs).toBe(6 * 60 * 60_000)

    expect(tierFor(daysAgo(15), now).tier).toBe("monthly")
    expect(tierFor(daysAgo(15), now).intervalMs).toBe(86_400_000)

    expect(tierFor(daysAgo(60), now).tier).toBe("frozen")
    expect(tierFor(daysAgo(60), now).intervalMs).toBeNull()
  })
})

describe("isDue", () => {
  it("respects tier interval, frozen tier, deleted, and missing prereqs", async () => {
    const { isDue } = await import("../src/server/metrics")
    const now = new Date("2026-04-28T12:00:00Z")
    const ago = (mins: number) => new Date(now.getTime() - mins * 60_000).toISOString()

    // Active tier (5min), never captured, within backfill bound → due.
    expect(
      isDue(
        { id: "p1", external_post_id: "x1", published_at: ago(30), deleted_at: null },
        null,
        0,
        null,
        {},
        now,
      ),
    ).toBe(true)

    // Just refreshed 1min ago in active tier (5min) → NOT due.
    expect(
      isDue(
        { id: "p2", external_post_id: "x2", published_at: ago(30), deleted_at: null },
        ago(1),
        0,
        null,
        {},
        now,
      ),
    ).toBe(false)

    // Refreshed 6min ago in active tier → due again.
    expect(
      isDue(
        { id: "p3", external_post_id: "x3", published_at: ago(30), deleted_at: null },
        ago(6),
        0,
        null,
        {},
        now,
      ),
    ).toBe(true)

    // Frozen tier (60d old) → never due.
    expect(
      isDue(
        {
          id: "p4",
          external_post_id: "x4",
          published_at: new Date(now.getTime() - 60 * 86_400_000).toISOString(),
          deleted_at: null,
        },
        null,
        0,
        null,
        {},
        now,
      ),
    ).toBe(false)

    // Deleted on platform → never due.
    expect(
      isDue(
        {
          id: "p5",
          external_post_id: "x5",
          published_at: ago(30),
          deleted_at: ago(10),
        },
        null,
        0,
        null,
        {},
        now,
      ),
    ).toBe(false)

    // No published_at → never due.
    expect(
      isDue(
        { id: "p6", external_post_id: "x6", published_at: null, deleted_at: null },
        null,
        0,
        null,
        {},
        now,
      ),
    ).toBe(false)
  })

  it("first-launch backfill bound — never-captured + > 7d old → not due unless force", async () => {
    const { isDue } = await import("../src/server/metrics")
    const now = new Date("2026-04-28T12:00:00Z")
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000).toISOString()

    // Within 30d so tier is monthly (1d interval), never captured, but
    // older than 7d backfill bound → skip on first capture.
    expect(
      isDue(
        {
          id: "p1",
          external_post_id: "x1",
          published_at: tenDaysAgo,
          deleted_at: null,
        },
        null,
        0,
        null,
        {},
        now,
      ),
    ).toBe(false)

    // force=true bypasses the bound.
    expect(
      isDue(
        {
          id: "p1",
          external_post_id: "x1",
          published_at: tenDaysAgo,
          deleted_at: null,
        },
        null,
        0,
        null,
        { force: true },
        now,
      ),
    ).toBe(true)
  })
})

describe("refreshPostMetrics", () => {
  it("fetches metrics, writes snapshots, logs run + usage", async () => {
    seedPosts([
      {
        id: "post-a",
        external_post_id: "1001",
        status: "published",
        published_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
      {
        id: "post-b",
        external_post_id: "1002",
        status: "published",
        published_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ])
    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: {
        data: [
          {
            id: "1001",
            public_metrics: {
              impression_count: 1500,
              like_count: 42,
              reply_count: 3,
              retweet_count: 5,
              quote_count: 2,
              bookmark_count: 9,
            },
          },
          {
            id: "1002",
            public_metrics: {
              impression_count: 800,
              like_count: 12,
              reply_count: 0,
              retweet_count: 1,
              quote_count: 0,
              bookmark_count: 2,
            },
          },
        ],
      },
      headers: {},
    })

    const { refreshPostMetrics } = await import("../src/server/metrics")
    const { getDb } = await import("../src/server/db")
    const result = await refreshPostMetrics({})

    expect(result.posts_considered).toBe(2)
    expect(result.posts_refreshed).toBe(2)
    expect(result.posts_skipped).toBe(0)
    expect(result.posts_deleted).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.rate_limited).toBe(false)

    const db = getDb()
    const rows = db
      .prepare(
        "SELECT post_id, impressions, likes, comments, shares, bookmarks FROM twitter_post_metrics ORDER BY post_id",
      )
      .all() as Array<{
      post_id: string
      impressions: number
      likes: number
      comments: number
      shares: number
      bookmarks: number
    }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      post_id: "post-a",
      impressions: 1500,
      likes: 42,
      comments: 3,
      shares: 7, // retweet + quote
      bookmarks: 9,
    })

    const usage = db
      .prepare(
        "SELECT calls_succeeded, calls_failed, calls_rate_limited FROM twitter_api_usage",
      )
      .get() as { calls_succeeded: number; calls_failed: number; calls_rate_limited: number }
    expect(usage.calls_succeeded).toBe(1)
    expect(usage.calls_failed).toBe(0)
    expect(usage.calls_rate_limited).toBe(0)

    const run = db
      .prepare(
        "SELECT posts_refreshed, posts_skipped, kind FROM twitter_metrics_runs ORDER BY id DESC LIMIT 1",
      )
      .get() as { posts_refreshed: number; posts_skipped: number; kind: string }
    expect(run.kind).toBe("refresh")
    expect(run.posts_refreshed).toBe(2)
    db.close()
  })

  it("marks deleted_at when Twitter reports the tweet as not_found", async () => {
    seedPosts([
      {
        id: "ghost",
        external_post_id: "9999",
        status: "published",
        published_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ])
    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: {
        errors: [
          {
            resource_id: "9999",
            type: "https://api.twitter.com/2/problems/resource-not-found",
            title: "Not Found Error",
            detail: "Could not find tweet with id 9999",
          },
        ],
      },
      headers: {},
    })

    const { refreshPostMetrics } = await import("../src/server/metrics")
    const { getDb } = await import("../src/server/db")
    const result = await refreshPostMetrics({})
    expect(result.posts_deleted).toBe(1)
    expect(result.posts_refreshed).toBe(0)

    const post = getDb()
      .prepare("SELECT deleted_at FROM twitter_posts WHERE id = 'ghost'")
      .get() as { deleted_at: string | null }
    expect(post.deleted_at).not.toBeNull()
    getDb().close()
  })

  it("trips rate_limited and logs usage on 429", async () => {
    seedPosts([
      {
        id: "p1",
        external_post_id: "1",
        status: "published",
        published_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ])
    proxyMock.mockResolvedValueOnce({ status: 429, data: {}, headers: {} })

    const { refreshPostMetrics } = await import("../src/server/metrics")
    const { getDb } = await import("../src/server/db")
    const result = await refreshPostMetrics({})
    expect(result.rate_limited).toBe(true)
    expect(result.posts_refreshed).toBe(0)

    const usage = getDb()
      .prepare("SELECT calls_rate_limited FROM twitter_api_usage")
      .get() as { calls_rate_limited: number }
    expect(usage.calls_rate_limited).toBe(1)
    getDb().close()
  })
})

describe("rollupAndPrune", () => {
  it("aggregates per-day MAX into the daily table and prunes > 90d snapshots", async () => {
    seedPosts([
      {
        id: "post-a",
        external_post_id: "1001",
        status: "published",
        published_at: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ])
    // Direct sqlite seeding — bypasses the Composio path entirely.
    const dbPath = join(scratchDir, "test.db")
    const seedDb = new Database(dbPath)
    seedDb.exec(`
      CREATE TABLE twitter_post_metrics (
        post_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        impressions INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, bookmarks INTEGER,
        raw TEXT,
        PRIMARY KEY (post_id, captured_at)
      );
      CREATE TABLE twitter_post_metrics_daily (
        post_id TEXT NOT NULL,
        day TEXT NOT NULL,
        impressions INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, bookmarks INTEGER,
        PRIMARY KEY (post_id, day)
      );
      CREATE TABLE twitter_metrics_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        kind TEXT NOT NULL DEFAULT 'refresh',
        posts_considered INTEGER NOT NULL DEFAULT 0,
        posts_refreshed INTEGER NOT NULL DEFAULT 0,
        posts_skipped INTEGER NOT NULL DEFAULT 0,
        posts_deleted INTEGER NOT NULL DEFAULT 0,
        errors_json TEXT
      );
    `)
    // 3 snapshots on yesterday (max should win), 1 ancient (should be pruned).
    const yesterday = "2026-04-27"
    const ancient = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 19) + "Z"
    const insert = seedDb.prepare(
      "INSERT INTO twitter_post_metrics (post_id, captured_at, impressions, likes, comments, shares, bookmarks) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    insert.run("post-a", `${yesterday}T08:00:00.000Z`, 100, 5, 0, 0, 0)
    insert.run("post-a", `${yesterday}T16:00:00.000Z`, 250, 9, 1, 0, 0)
    insert.run("post-a", `${yesterday}T22:00:00.000Z`, 200, 8, 1, 0, 0)
    insert.run("post-a", ancient, 5, 1, 0, 0, 0)
    seedDb.close()

    const { rollupAndPrune } = await import("../src/server/metrics-rollup")
    const result = rollupAndPrune()
    expect(result.days_rolled).toBeGreaterThanOrEqual(1)
    expect(result.rows_pruned).toBe(1)

    const { getDb } = await import("../src/server/db")
    const dailyRow = getDb()
      .prepare(
        "SELECT impressions, likes, comments FROM twitter_post_metrics_daily WHERE post_id = 'post-a' AND day = ?",
      )
      .get(yesterday) as { impressions: number; likes: number; comments: number } | undefined
    expect(dailyRow).toBeDefined()
    expect(dailyRow?.impressions).toBe(250)
    expect(dailyRow?.likes).toBe(9)
    expect(dailyRow?.comments).toBe(1)

    // Ancient snapshot pruned.
    const ancientCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM twitter_post_metrics WHERE captured_at = ?")
      .get(ancient) as { c: number }
    expect(ancientCount.c).toBe(0)
    getDb().close()
  })
})

describe("metrics_refresh_enabled flag", () => {
  it("defaults to true and persists flips", async () => {
    seedPosts([])
    const { isMetricsRefreshEnabled, setMetricsRefreshEnabled } = await import(
      "../src/server/metrics"
    )
    expect(isMetricsRefreshEnabled()).toBe(true)
    setMetricsRefreshEnabled(false)
    expect(isMetricsRefreshEnabled()).toBe(false)
    setMetricsRefreshEnabled(true)
    expect(isMetricsRefreshEnabled()).toBe(true)
  })
})
