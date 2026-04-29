import { getDb } from "./db"

export interface RollupResult {
  run_id: number
  days_rolled: number
  rows_pruned: number
}

const RETENTION_DAYS = 90

// Materializes the daily MAX per post for every day older than today
// that doesn't already have a daily row, then prunes raw snapshots
// older than RETENTION_DAYS. Idempotent — re-running on a day that's
// already rolled up is a no-op for that day.
//
// Pure function, callable directly from the in-process scheduler or
// from the twitter_rollup_post_metrics MCP wrapper.
export function rollupAndPrune(): RollupResult {
  const db = getDb()
  const startedAt = new Date().toISOString()
  const runId = Number(
    db
      .prepare(
        "INSERT INTO twitter_metrics_runs (started_at, kind) VALUES (?, 'rollup')",
      )
      .run(startedAt).lastInsertRowid,
  )

  // Find raw-snapshot days that don't yet have any daily-rollup rows.
  // Only roll up days strictly before today, so an in-progress day's
  // not-yet-final values don't get materialized + then frozen if rollup
  // runs at e.g. 23:55 then never re-runs for that day.
  const daysToRoll = db
    .prepare(`
      SELECT DISTINCT date(captured_at) AS day
      FROM twitter_post_metrics
      WHERE date(captured_at) < date('now')
        AND date(captured_at) NOT IN (SELECT day FROM twitter_post_metrics_daily)
      ORDER BY day
    `)
    .all() as Array<{ day: string }>

  const rollupStmt = db.prepare(`
    INSERT OR REPLACE INTO twitter_post_metrics_daily
      (post_id, day, impressions, likes, comments, shares, bookmarks)
    SELECT post_id,
           date(captured_at) AS day,
           MAX(impressions) AS impressions,
           MAX(likes) AS likes,
           MAX(comments) AS comments,
           MAX(shares) AS shares,
           MAX(bookmarks) AS bookmarks
    FROM twitter_post_metrics
    WHERE date(captured_at) = ?
    GROUP BY post_id
  `)

  let daysRolled = 0
  for (const { day } of daysToRoll) {
    rollupStmt.run(day)
    daysRolled += 1
  }

  // 90-day retention on raw snapshots. Daily rollup keeps the
  // aggregate available beyond this, so trend dashboards reading the
  // daily table aren't affected.
  const pruneInfo = db
    .prepare(
      `DELETE FROM twitter_post_metrics WHERE captured_at < datetime('now', ?)`,
    )
    .run(`-${RETENTION_DAYS} days`)

  db.prepare(
    `UPDATE twitter_metrics_runs SET
       finished_at = datetime('now'),
       posts_considered = ?,
       posts_refreshed = ?,
       errors_json = NULL
     WHERE id = ?`,
  ).run(daysRolled, Number(pruneInfo.changes), runId)

  return {
    run_id: runId,
    days_rolled: daysRolled,
    rows_pruned: Number(pruneInfo.changes),
  }
}

// Returns the timestamp of the last successful rollup run, or null if
// none has run. Used by the scheduler to decide whether the 24h tick
// has come due.
export function lastRollupAt(): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(finished_at) AS last_run FROM twitter_metrics_runs
       WHERE kind = 'rollup' AND finished_at IS NOT NULL`,
    )
    .get() as { last_run: string | null } | undefined
  return row?.last_run ?? null
}
