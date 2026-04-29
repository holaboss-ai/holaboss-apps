import type Database from "better-sqlite3"

import { getDb } from "./db"
import { createIntegrationClient } from "./holaboss-bridge"

// Reddit's public API behind Composio. We use /api/info?id=t3_<id>
// because it returns the post object directly (no need to drill into
// the /comments listing structure) and works for posts the
// authenticated user can see.
const REDDIT_API = "https://oauth.reddit.com"
const reddit = createIntegrationClient("reddit")

const HOUR_MS = 60 * 60 * 1000
const CAPTURE_INTERVAL_HOURS = 4
const TOTAL_CAPTURES = 12
const MONITORING_WINDOW_MS = TOTAL_CAPTURES * CAPTURE_INTERVAL_HOURS * HOUR_MS // 48h
// Process posts in small batches to avoid one hot post starving others
// when Composio is slow.
const BATCH_SIZE = 25

export interface TrackedPostRow {
  id: string
  external_post_id: string | null
  source_url: string | null
  subreddit: string
  monitoring_started_at: string | null
  monitoring_completed_at: string | null
  deleted_at: string | null
}

export interface RefreshOpts {
  /** Restrict to specific local post ids. Empty / undefined = all due tracked posts. */
  post_ids?: string[]
  /** Bypass the milestone check; always pull fresh metrics for the candidates. */
  force?: boolean
}

export interface RefreshResult {
  run_id: number
  posts_considered: number
  posts_refreshed: number
  posts_skipped: number
  posts_deleted: number
  posts_completed: number
  errors: Array<{ post_id: string; error: string }>
  rate_limited: boolean
}

interface RedditPostDataPayload {
  id: string
  score?: number
  ups?: number
  num_comments?: number
  upvote_ratio?: number
  created_utc?: number
  subreddit?: string
  title?: string
  removed_by_category?: string | null
  banned_at_utc?: number | null
  selftext?: string
  url?: string
  permalink?: string
}

interface RedditInfoResponse {
  data?: {
    children?: Array<{
      kind?: string
      data?: RedditPostDataPayload
    }>
  }
}

// Returns the milestone slot (0..TOTAL_CAPTURES-1) that the post is
// "currently in" given how long monitoring has been running. After
// the window expires returns null (post should transition to
// completed). The slot is the largest k such that `k * 4h <= ageMs`
// — i.e. the most recent milestone that has been crossed.
export function currentMilestone(
  monitoringStartedAt: Date,
  now: Date,
): number | null {
  const ageMs = now.getTime() - monitoringStartedAt.getTime()
  if (ageMs < 0) return null
  if (ageMs >= MONITORING_WINDOW_MS) return null
  return Math.min(
    Math.floor(ageMs / (CAPTURE_INTERVAL_HOURS * HOUR_MS)),
    TOTAL_CAPTURES - 1,
  )
}

// Returns true when the post needs a fresh capture this tick. The
// rule: a milestone is "done" when at least one snapshot exists with
// captured_at >= the milestone's wall-clock time. Force bypasses the
// check entirely (manual / agent-driven).
export function isMilestoneDue(
  monitoringStartedAt: Date,
  lastCaptured: string | null,
  lastCapturedMilestone: number | null,
  now: Date,
  force: boolean,
): { due: boolean; milestoneIdx: number | null } {
  if (force) {
    const milestone = currentMilestone(monitoringStartedAt, now)
    return { due: true, milestoneIdx: milestone }
  }
  const milestone = currentMilestone(monitoringStartedAt, now)
  if (milestone === null) return { due: false, milestoneIdx: null }

  // Already captured at this milestone or later? Skip.
  if (lastCapturedMilestone !== null && lastCapturedMilestone >= milestone) {
    return { due: false, milestoneIdx: milestone }
  }

  // Last capture must also predate the milestone's wall-clock time
  // (defensive — if for some reason milestone_idx was null but the
  // capture happened recently, don't double-tap).
  const milestoneStart =
    monitoringStartedAt.getTime() +
    milestone * CAPTURE_INTERVAL_HOURS * HOUR_MS
  if (lastCaptured && new Date(lastCaptured).getTime() >= milestoneStart) {
    return { due: false, milestoneIdx: milestone }
  }
  return { due: true, milestoneIdx: milestone }
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
    posts_completed: 0,
    errors: [],
    rate_limited: false,
  }

  const runId = Number(
    db
      .prepare(
        "INSERT INTO reddit_metrics_runs (started_at, kind) VALUES (?, 'refresh')",
      )
      .run(startedAt).lastInsertRowid,
  )

  try {
    const candidates = loadCandidates(db, opts.post_ids)
    result.posts_considered = candidates.length

    const now = new Date()
    interface DueEntry {
      post: TrackedPostRow
      milestoneIdx: number | null
    }
    const due: DueEntry[] = []
    for (const post of candidates) {
      // Promote to "completed" when the 48h window has elapsed and
      // we haven't already locked in final values. Pull the last
      // snapshot's values into the post row + set
      // monitoring_completed_at, then move on without touching the API.
      const startedAtIso = post.monitoring_started_at
      if (!startedAtIso) {
        result.posts_skipped += 1
        continue
      }
      const startedDate = new Date(startedAtIso)
      const ageMs = now.getTime() - startedDate.getTime()
      if (ageMs >= MONITORING_WINDOW_MS && !post.monitoring_completed_at) {
        completePost(db, post.id, now.toISOString())
        result.posts_completed += 1
        continue
      }
      if (post.monitoring_completed_at) {
        result.posts_skipped += 1
        continue
      }

      const meta = readMilestoneMeta(db, post.id)
      const decision = isMilestoneDue(
        startedDate,
        meta.lastCaptured,
        meta.lastMilestone,
        now,
        Boolean(opts.force),
      )
      if (decision.due) {
        due.push({ post, milestoneIdx: decision.milestoneIdx })
      } else {
        result.posts_skipped += 1
      }
    }

    if (due.length === 0) {
      finishRun(db, runId, result)
      return { run_id: runId, ...result }
    }

    const capturedAt = roundToMinute(new Date()).toISOString()
    const insertSnapshot = db.prepare(`
      INSERT OR REPLACE INTO reddit_post_metrics
        (post_id, captured_at, score, num_comments, upvote_ratio, milestone_idx, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const markDeleted = db.prepare(
      `UPDATE reddit_posts
         SET deleted_at = ?,
             deleted_reason = ?,
             deleted_reason_raw = ?,
             updated_at = datetime('now')
       WHERE id = ?`,
    )

    for (let i = 0; i < due.length; i += BATCH_SIZE) {
      const batch = due.slice(i, i + BATCH_SIZE)
      const idsParam = batch
        .map((entry) => entry.post.external_post_id)
        .filter((x): x is string => Boolean(x))
        .map((rawId) => (rawId.startsWith("t3_") ? rawId : `t3_${rawId}`))
        .join(",")

      try {
        const response = await reddit.proxy<RedditInfoResponse>({
          method: "GET",
          endpoint: `${REDDIT_API}/api/info?id=${idsParam}&raw_json=1`,
        })

        if (response.status === 429) {
          result.rate_limited = true
          incrementUsage(db, "calls_rate_limited", 1)
          break // retry next tick
        }
        if (response.status >= 500) {
          incrementUsage(db, "calls_failed", 1)
          for (const entry of batch) {
            result.errors.push({
              post_id: entry.post.id,
              error: `upstream_${response.status}`,
            })
          }
          continue
        }

        incrementUsage(db, "calls_succeeded", 1)

        const seenExternal = new Set<string>()
        for (const child of response.data?.data?.children ?? []) {
          const data = child?.data
          if (!data?.id) continue
          seenExternal.add(data.id)
          const entry = batch.find(
            (e) =>
              normalizeExternalId(e.post.external_post_id) ===
              normalizeExternalId(data.id),
          )
          if (!entry) continue

          // Reddit returns metadata even after the post is removed
          // — `removed_by_category` is the canonical signal. Still
          // capture the row's snapshot so the timeline shows the
          // moment of removal.
          const removalRaw = data.removed_by_category ?? null
          const score = data.score ?? data.ups ?? null
          const numComments = data.num_comments ?? null
          const upvoteRatio = data.upvote_ratio ?? null

          insertSnapshot.run(
            entry.post.id,
            capturedAt,
            score,
            numComments,
            upvoteRatio,
            entry.milestoneIdx,
            JSON.stringify({
              score,
              num_comments: numComments,
              upvote_ratio: upvoteRatio,
              removed_by_category: removalRaw,
            }),
          )

          if (removalRaw && !entry.post.deleted_at) {
            markDeleted.run(
              new Date().toISOString(),
              normalizeRemovalReason(removalRaw),
              removalRaw,
              entry.post.id,
            )
            result.posts_deleted += 1
          } else {
            result.posts_refreshed += 1
          }
        }

        // Anything in batch but absent from the response is a hard
        // 404 — the post id no longer resolves at all (rare, since
        // Reddit usually keeps tombstones). Treat as deleted with a
        // synthetic reason so the dashboard shows it.
        for (const entry of batch) {
          if (!entry.post.external_post_id) continue
          if (
            !seenExternal.has(
              normalizeExternalId(entry.post.external_post_id),
            )
          ) {
            if (!entry.post.deleted_at) {
              markDeleted.run(
                new Date().toISOString(),
                "unknown",
                "not_found",
                entry.post.id,
              )
              result.posts_deleted += 1
            } else {
              result.posts_skipped += 1
            }
          }
        }
      } catch (err) {
        incrementUsage(db, "calls_failed", 1)
        const msg = err instanceof Error ? err.message : String(err)
        for (const entry of batch) {
          result.errors.push({ post_id: entry.post.id, error: msg })
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

// Locks in the final values for a post once the 48h window expires.
// Pulls the most recent snapshot row's values into reddit_posts.* —
// downstream dashboards prefer the post-row columns because they
// render zero rows of joined snapshot data per post.
function completePost(
  db: Database.Database,
  postId: string,
  finishedAtIso: string,
): void {
  const last = db
    .prepare(
      `SELECT score, num_comments, upvote_ratio
       FROM reddit_post_metrics
       WHERE post_id = ?
       ORDER BY captured_at DESC
       LIMIT 1`,
    )
    .get(postId) as
    | { score: number | null; num_comments: number | null; upvote_ratio: number | null }
    | undefined
  db.prepare(
    `UPDATE reddit_posts
       SET monitoring_completed_at = ?,
           final_score = ?,
           final_num_comments = ?,
           final_upvote_ratio = ?,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    finishedAtIso,
    last?.score ?? null,
    last?.num_comments ?? null,
    last?.upvote_ratio ?? null,
    postId,
  )
}

// Reddit's removed_by_category enum values, normalized to a small
// human-friendly set the dashboard groups by. Anything we don't
// recognize falls through as "other" so the raw value still lives in
// reddit_posts.deleted_reason_raw for forensics.
function normalizeRemovalReason(raw: string): string {
  const v = raw.trim().toLowerCase()
  if (v === "moderator" || v === "subreddit_moderator") return "mod_removed"
  if (v === "automod_filtered") return "automod"
  if (v === "anti_evil_ops" || v === "reddit") return "reddit_admin"
  if (v === "author" || v === "deleted") return "user_deleted"
  if (v === "copyright_takedown") return "dmca"
  return "other"
}

function normalizeExternalId(id: string | null | undefined): string {
  if (!id) return ""
  return id.startsWith("t3_") ? id.slice(3) : id
}

interface MilestoneMeta {
  lastCaptured: string | null
  lastMilestone: number | null
}

function readMilestoneMeta(db: Database.Database, postId: string): MilestoneMeta {
  const row = db
    .prepare(
      `SELECT captured_at, milestone_idx
       FROM reddit_post_metrics
       WHERE post_id = ?
       ORDER BY captured_at DESC
       LIMIT 1`,
    )
    .get(postId) as { captured_at: string; milestone_idx: number | null } | undefined
  if (!row) return { lastCaptured: null, lastMilestone: null }
  return {
    lastCaptured: row.captured_at,
    lastMilestone: row.milestone_idx,
  }
}

function loadCandidates(
  db: Database.Database,
  postIds: string[] | undefined,
): TrackedPostRow[] {
  if (postIds && postIds.length > 0) {
    const placeholders = postIds.map(() => "?").join(",")
    return db
      .prepare(
        `SELECT id, external_post_id, source_url, subreddit, monitoring_started_at,
                monitoring_completed_at, deleted_at
         FROM reddit_posts WHERE id IN (${placeholders})`,
      )
      .all(...postIds) as TrackedPostRow[]
  }
  return db
    .prepare(
      `SELECT id, external_post_id, source_url, subreddit, monitoring_started_at,
              monitoring_completed_at, deleted_at
       FROM reddit_posts
       WHERE source_url IS NOT NULL
         AND monitoring_started_at IS NOT NULL
         AND external_post_id IS NOT NULL`,
    )
    .all() as TrackedPostRow[]
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
    `UPDATE reddit_metrics_runs SET
       finished_at = datetime('now'),
       posts_considered = ?,
       posts_refreshed = ?,
       posts_skipped = ?,
       posts_deleted = ?,
       posts_completed = ?,
       errors_json = ?
     WHERE id = ?`,
  ).run(
    result.posts_considered,
    result.posts_refreshed,
    result.posts_skipped,
    result.posts_deleted,
    result.posts_completed,
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
    `INSERT INTO reddit_api_usage (date, ${column}, updated_at)
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

export function isMetricsRefreshEnabled(): boolean {
  const row = getDb()
    .prepare(
      "SELECT value FROM reddit_settings WHERE key = 'metrics_refresh_enabled'",
    )
    .get() as { value: string } | undefined
  return row ? row.value !== "0" : true
}

export function setMetricsRefreshEnabled(enabled: boolean): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO reddit_settings (key, value, updated_at)
     VALUES ('metrics_refresh_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(enabled ? "1" : "0")
}
