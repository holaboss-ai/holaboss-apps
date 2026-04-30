import type Database from "better-sqlite3"

import { getDb } from "./db"
import { createIntegrationClient } from "./holaboss-bridge"

// Composio's twitter toolkit allow-lists `api.x.com` post-rebrand.
const TWITTER_API = "https://api.x.com/2"
const twitter = createIntegrationClient("twitter")

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const FROZEN_AFTER_MS = 30 * DAY_MS
// Refuse first-capture for posts older than this on a fresh install,
// to avoid blasting the API for an account with hundreds of historical
// posts. Agent-driven { force: true } bypasses this.
const BACKFILL_BOUND_MS = 7 * DAY_MS
// After this many consecutive errors on the same post, mute it for
// 24h so a permanently-broken row doesn't burn API calls forever.
const ERROR_MUTE_THRESHOLD = 5
const ERROR_MUTE_DURATION_MS = 24 * HOUR_MS
// Twitter v2 GET /tweets accepts up to 100 ids per call.
const BATCH_SIZE = 100

export type Tier = "active" | "settling" | "weekly" | "monthly" | "frozen"

export interface PostRow {
  id: string
  external_post_id: string | null
  published_at: string | null
  deleted_at: string | null
}

export interface RefreshOpts {
  /** Restrict to specific local post ids. Empty / undefined = all due posts. */
  post_ids?: string[]
  /** Override the tier policy and the backfill bound; refresh whatever was asked. */
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

interface TwitterMetricsResponse {
  data?: Array<{
    id: string
    public_metrics?: {
      impression_count?: number
      like_count?: number
      reply_count?: number
      retweet_count?: number
      quote_count?: number
      bookmark_count?: number
    }
  }>
  errors?: Array<{
    resource_id?: string
    parameter?: string
    type?: string
    title?: string
    detail?: string
  }>
}

// Computes the refresh interval bucket for a published post based on
// its age. The schedule deliberately samples newer posts more often
// (engagement curve is steepest in the first day).
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

// Returns true when the post should be refreshed this tick. Not pure
// — reads the consecutive-error mute window so a chronically-failing
// post stops eating quota. force=true bypasses tier + mute + backfill.
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

  // Mute if too many recent consecutive errors.
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
  if (intervalMs === null) return false // frozen tier

  if (!lastCaptured) {
    // Backfill bound — only first-capture recent posts.
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
        "INSERT INTO twitter_metrics_runs (started_at, kind) VALUES (?, 'refresh')",
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
      INSERT OR REPLACE INTO twitter_post_metrics
        (post_id, captured_at, impressions, likes, comments, shares, bookmarks, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const markDeleted = db.prepare(
      "UPDATE twitter_posts SET deleted_at = ?, updated_at = datetime('now') WHERE id = ?",
    )

    for (let i = 0; i < due.length; i += BATCH_SIZE) {
      const batch = due.slice(i, i + BATCH_SIZE)
      const idsParam = batch
        .map((p) => p.external_post_id)
        .filter((x): x is string => Boolean(x))
        .join(",")

      try {
        const response = await twitter.proxy<TwitterMetricsResponse>({
          method: "GET",
          endpoint: `${TWITTER_API}/tweets?ids=${idsParam}&tweet.fields=public_metrics`,
        })

        if (response.status === 429) {
          result.rate_limited = true
          incrementUsage(db, "calls_rate_limited", 1)
          // Respect upstream — drop the rest of the run, retry next tick.
          break
        }
        if (response.status >= 500) {
          incrementUsage(db, "calls_failed", 1)
          for (const post of batch) {
            result.errors.push({
              post_id: post.id,
              error: `upstream_${response.status}`,
            })
          }
          continue
        }

        incrementUsage(db, "calls_succeeded", 1)

        const seenExternal = new Set<string>()
        for (const row of response.data?.data ?? []) {
          seenExternal.add(row.id)
          const post = batch.find((p) => p.external_post_id === row.id)
          if (!post) continue
          const m = row.public_metrics ?? {}
          // Twitter "shares" = retweets + quotes — flatten here so the
          // common column has a useful single value.
          const shares =
            (m.retweet_count ?? 0) + (m.quote_count ?? 0) || null
          insertSnapshot.run(
            post.id,
            capturedAt,
            m.impression_count ?? null,
            m.like_count ?? null,
            m.reply_count ?? null,
            shares,
            m.bookmark_count ?? null,
            JSON.stringify(m),
          )
          result.posts_refreshed += 1
        }

        // Anything in batch but not in seenExternal — Twitter says the
        // tweet doesn't exist (or we don't have access). Treat that
        // explicitly via the errors array; otherwise classify generically.
        const errorByExternalId = new Map<string, NonNullable<TwitterMetricsResponse["errors"]>[number]>()
        for (const e of response.data?.errors ?? []) {
          if (e.resource_id) errorByExternalId.set(e.resource_id, e)
        }
        for (const post of batch) {
          if (!post.external_post_id) continue
          if (seenExternal.has(post.external_post_id)) continue
          const errEntry = errorByExternalId.get(post.external_post_id)
          const isNotFound =
            (errEntry?.type ?? "").toLowerCase().includes("not_found") ||
            (errEntry?.title ?? "").toLowerCase().includes("not found")
          if (isNotFound) {
            markDeleted.run(new Date().toISOString(), post.id)
            result.posts_deleted += 1
          } else {
            result.errors.push({
              post_id: post.id,
              error: errEntry?.detail ?? errEntry?.title ?? "no metrics returned",
            })
          }
        }
      } catch (err) {
        incrementUsage(db, "calls_failed", 1)
        const msg = err instanceof Error ? err.message : String(err)
        for (const post of batch) {
          result.errors.push({ post_id: post.id, error: msg })
        }
      }
    }

    finishRun(db, runId, result)
    return { run_id: runId, ...result }
  } catch (err) {
    finishRun(db, runId, result, err instanceof Error ? err.message : String(err))
    throw err
  }
}

// Settings stored in the same workspace db as everything else, so a
// tool toggle survives restarts and is visible to dashboards. The
// twitter_settings table is declared in app.runtime.yaml's
// data_schema and created by the runtime — no lazy CREATE here.
export function isMetricsRefreshEnabled(): boolean {
  const row = getDb()
    .prepare(
      "SELECT value FROM twitter_settings WHERE key = 'metrics_refresh_enabled'",
    )
    .get() as { value: string } | undefined
  // Default ON. User-driven flip via twitter_set_metrics_refresh.
  return row ? row.value !== "0" : true
}

export function setMetricsRefreshEnabled(enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO twitter_settings (key, value, updated_at)
       VALUES ('metrics_refresh_enabled', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(enabled ? "1" : "0")
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
         FROM twitter_posts WHERE id IN (${placeholders})`,
      )
      .all(...postIds) as PostRow[]
  }
  return db
    .prepare(
      `SELECT id, external_post_id, published_at, deleted_at
       FROM twitter_posts
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
      "SELECT MAX(captured_at) AS captured_at FROM twitter_post_metrics WHERE post_id = ?",
    )
    .get(postId) as { captured_at: string | null } | undefined
  // Recent errors = number of consecutive non-success runs that
  // mentioned this post id, looking only at the last 5 runs that
  // touched it. Approximation — we read the last 5 runs' errors_json
  // and count the post.
  const recentRuns = db
    .prepare(
      `SELECT errors_json, started_at FROM twitter_metrics_runs
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
        // Streak broken by a successful run.
        break
      }
    } catch {
      // Malformed errors_json — ignore.
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
    `UPDATE twitter_metrics_runs SET
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
    `INSERT INTO twitter_api_usage (date, ${column}, updated_at)
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
