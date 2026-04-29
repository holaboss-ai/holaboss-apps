import type Database from "better-sqlite3"

import { getDb } from "./db"
import { createIntegrationClient } from "./holaboss-bridge"

// LinkedIn's social-actions endpoint returns aggregate likes / comments
// for a UGC post. Reach / impressions require the marketing analytics
// API (elevated access) and aren't fetched here — `impressions` is
// nullable on the snapshot row.
const LINKEDIN_API = "https://api.linkedin.com/v2"
const linkedin = createIntegrationClient("linkedin")

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const FROZEN_AFTER_MS = 30 * DAY_MS
const BACKFILL_BOUND_MS = 7 * DAY_MS
const ERROR_MUTE_THRESHOLD = 5
const ERROR_MUTE_DURATION_MS = 24 * HOUR_MS

export type Tier = "active" | "settling" | "weekly" | "monthly" | "frozen"

export interface PostRow {
  id: string
  external_post_id: string | null
  published_at: string | null
  deleted_at: string | null
}

export interface RefreshOpts {
  post_ids?: string[]
  force?: boolean
}

export interface RefreshResult {
  run_id: number
  posts_considered: number
  posts_refreshed: number
  posts_skipped: number
  posts_deleted: number
  errors: Array<{ post_id: string; error: string }>
  rate_limited: boolean
}

interface LinkedinSocialActionsResponse {
  likesSummary?: {
    totalLikes?: number
    aggregatedTotalLikes?: number
  }
  commentsSummary?: {
    totalFirstLevelComments?: number
    aggregatedTotalComments?: number
  }
  sharesSummary?: {
    totalShares?: number
  }
}

export function tierFor(publishedAt: Date, now = new Date()): {
  tier: Tier
  intervalMs: number | null
} {
  const age = now.getTime() - publishedAt.getTime()
  if (age < HOUR_MS) return { tier: "active", intervalMs: 5 * 60 * 1000 }
  if (age < DAY_MS) return { tier: "settling", intervalMs: 30 * 60 * 1000 }
  if (age < 7 * DAY_MS) return { tier: "weekly", intervalMs: 6 * HOUR_MS }
  if (age < FROZEN_AFTER_MS) return { tier: "monthly", intervalMs: DAY_MS }
  return { tier: "frozen", intervalMs: null }
}

export function isDue(
  post: PostRow,
  lastCaptured: string | null,
  recentErrors: number,
  lastErrorAt: string | null,
  opts: { force?: boolean } = {},
  now = new Date(),
): boolean {
  if (!post.published_at) return false
  if (post.deleted_at) return false
  if (!post.external_post_id) return false
  if (opts.force) return true

  if (
    recentErrors >= ERROR_MUTE_THRESHOLD &&
    lastErrorAt &&
    now.getTime() - new Date(lastErrorAt).getTime() < ERROR_MUTE_DURATION_MS
  ) {
    return false
  }

  const publishedAt = new Date(post.published_at)
  if (Number.isNaN(publishedAt.getTime())) return false

  const { intervalMs } = tierFor(publishedAt, now)
  if (intervalMs === null) return false

  if (!lastCaptured) {
    return now.getTime() - publishedAt.getTime() <= BACKFILL_BOUND_MS
  }
  const sinceLast = now.getTime() - new Date(lastCaptured).getTime()
  return sinceLast >= intervalMs
}

export async function refreshPostMetrics(
  opts: RefreshOpts = {},
): Promise<RefreshResult> {
  const db = getDb()
  const startedAt = new Date().toISOString()
  const result: Omit<RefreshResult, "run_id"> = {
    posts_considered: 0,
    posts_refreshed: 0,
    posts_skipped: 0,
    posts_deleted: 0,
    errors: [],
    rate_limited: false,
  }

  const runId = Number(
    db
      .prepare(
        "INSERT INTO linkedin_metrics_runs (started_at, kind) VALUES (?, 'refresh')",
      )
      .run(startedAt).lastInsertRowid,
  )

  try {
    const candidates = loadCandidates(db, opts.post_ids)
    result.posts_considered = candidates.length

    const due = candidates.filter((post) => {
      const meta = readPostMetricsMeta(db, post.id)
      if (
        isDue(post, meta.lastCaptured, meta.recentErrors, meta.lastErrorAt, opts)
      ) {
        return true
      }
      result.posts_skipped += 1
      return false
    })

    if (due.length === 0) {
      finishRun(db, runId, result)
      return { run_id: runId, ...result }
    }

    const capturedAt = roundToMinute(new Date()).toISOString()
    const insertSnapshot = db.prepare(`
      INSERT OR REPLACE INTO linkedin_post_metrics
        (post_id, captured_at, impressions, likes, comments, shares, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const markDeleted = db.prepare(
      "UPDATE linkedin_posts SET deleted_at = ?, updated_at = datetime('now') WHERE id = ?",
    )

    // LinkedIn's socialActions endpoint is single-post (no batch by id
    // list), so we fan out one call per post. Posts share the API
    // bucket so a 429 still aborts the rest of the run.
    for (const post of due) {
      if (!post.external_post_id) {
        result.posts_skipped += 1
        continue
      }
      try {
        const urn = encodeURIComponent(post.external_post_id)
        const response = await linkedin.proxy<LinkedinSocialActionsResponse>({
          method: "GET",
          endpoint: `${LINKEDIN_API}/socialActions/${urn}`,
        })

        if (response.status === 429) {
          result.rate_limited = true
          incrementUsage(db, "calls_rate_limited", 1)
          break
        }
        if (response.status === 404 || response.status === 410) {
          incrementUsage(db, "calls_succeeded", 1)
          markDeleted.run(new Date().toISOString(), post.id)
          result.posts_deleted += 1
          continue
        }
        if (response.status >= 400) {
          incrementUsage(db, "calls_failed", 1)
          result.errors.push({
            post_id: post.id,
            error: `upstream_${response.status}`,
          })
          continue
        }

        incrementUsage(db, "calls_succeeded", 1)

        const data = response.data ?? {}
        const likes =
          data.likesSummary?.totalLikes ??
          data.likesSummary?.aggregatedTotalLikes ??
          null
        const comments =
          data.commentsSummary?.aggregatedTotalComments ??
          data.commentsSummary?.totalFirstLevelComments ??
          null
        const shares = data.sharesSummary?.totalShares ?? null
        // LinkedIn's basic socialActions doesn't return impressions —
        // would require the analytics API. Leave null; the metrics
        // schema common-column convention treats null as "unknown".
        const impressions: number | null = null

        insertSnapshot.run(
          post.id,
          capturedAt,
          impressions,
          likes,
          comments,
          shares,
          JSON.stringify(data),
        )
        result.posts_refreshed += 1
      } catch (err) {
        incrementUsage(db, "calls_failed", 1)
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push({ post_id: post.id, error: msg })
      }
    }

    finishRun(db, runId, result)
    return { run_id: runId, ...result }
  } catch (err) {
    finishRun(db, runId, result, err instanceof Error ? err.message : String(err))
    throw err
  }
}

export function isMetricsRefreshEnabled(): boolean {
  const row = getDb()
    .prepare(
      "SELECT value FROM linkedin_settings WHERE key = 'metrics_refresh_enabled'",
    )
    .get() as { value: string } | undefined
  return row ? row.value !== "0" : true
}

export function setMetricsRefreshEnabled(enabled: boolean): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO linkedin_settings (key, value, updated_at)
     VALUES ('metrics_refresh_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(enabled ? "1" : "0")
}

function loadCandidates(
  db: Database.Database,
  postIds: string[] | undefined,
): PostRow[] {
  if (postIds && postIds.length > 0) {
    const placeholders = postIds.map(() => "?").join(",")
    return db
      .prepare(
        `SELECT id, external_post_id, published_at, deleted_at
         FROM linkedin_posts WHERE id IN (${placeholders})`,
      )
      .all(...postIds) as PostRow[]
  }
  return db
    .prepare(
      `SELECT id, external_post_id, published_at, deleted_at
       FROM linkedin_posts
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND external_post_id IS NOT NULL`,
    )
    .all() as PostRow[]
}

interface PostMetricsMeta {
  lastCaptured: string | null
  recentErrors: number
  lastErrorAt: string | null
}

function readPostMetricsMeta(db: Database.Database, postId: string): PostMetricsMeta {
  const lastRow = db
    .prepare(
      "SELECT MAX(captured_at) AS captured_at FROM linkedin_post_metrics WHERE post_id = ?",
    )
    .get(postId) as { captured_at: string | null } | undefined
  const recentRuns = db
    .prepare(
      `SELECT errors_json, started_at FROM linkedin_metrics_runs
       WHERE kind = 'refresh' AND errors_json IS NOT NULL
       ORDER BY started_at DESC LIMIT 5`,
    )
    .all() as Array<{ errors_json: string | null; started_at: string }>
  let recentErrors = 0
  let lastErrorAt: string | null = null
  for (const run of recentRuns) {
    if (!run.errors_json) continue
    try {
      const parsed = JSON.parse(run.errors_json) as Array<{ post_id?: string }>
      if (parsed.some((e) => e.post_id === postId)) {
        recentErrors += 1
        if (!lastErrorAt) lastErrorAt = run.started_at
      } else if (recentErrors > 0) {
        break
      }
    } catch {
      // ignore malformed errors_json
    }
  }
  return {
    lastCaptured: lastRow?.captured_at ?? null,
    recentErrors,
    lastErrorAt,
  }
}

function finishRun(
  db: Database.Database,
  runId: number,
  result: Omit<RefreshResult, "run_id">,
  errorMessage: string | null = null,
): void {
  const errorsPayload = errorMessage
    ? JSON.stringify([{ error: errorMessage }, ...result.errors])
    : result.errors.length > 0
      ? JSON.stringify(result.errors)
      : null
  db.prepare(
    `UPDATE linkedin_metrics_runs SET
       finished_at = datetime('now'),
       posts_considered = ?,
       posts_refreshed = ?,
       posts_skipped = ?,
       posts_deleted = ?,
       errors_json = ?
     WHERE id = ?`,
  ).run(
    result.posts_considered,
    result.posts_refreshed,
    result.posts_skipped,
    result.posts_deleted,
    errorsPayload,
    runId,
  )
}

function incrementUsage(
  db: Database.Database,
  column: "calls_succeeded" | "calls_failed" | "calls_rate_limited",
  delta: number,
): void {
  const today = new Date().toISOString().slice(0, 10)
  db.prepare(
    `INSERT INTO linkedin_api_usage (date, ${column}, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       ${column} = ${column} + excluded.${column},
       updated_at = datetime('now')`,
  ).run(today, delta)
}

function roundToMinute(date: Date): Date {
  const ms = date.getTime()
  return new Date(ms - (ms % 60_000))
}
