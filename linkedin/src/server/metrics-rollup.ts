import { getDb } from "./db"

export interface RollupResult {
  run_id: number
  days_rolled: number
  rows_pruned: number
}

const RETENTION_DAYS = 90

// Materializes the daily MAX per post for every day older than today
// that doesn't already have a daily row, then prunes raw snapshots
// older than RETENTION_DAYS. Mirrors twitter's rollup; the only
// platform-specific bit is the absence of `bookmarks` from LinkedIn's
// schema.
export function rollupAndPrune(): RollupResult {
  const db = getDb()
  const startedAt = new Date().toISOString()
  const runId = Number(
    db
      .prepare(
        "INSERT INTO linkedin_metrics_runs (started_at, kind) VALUES (?, 'rollup')",
      )
      .run(startedAt).lastInsertRowid,
  )

  const daysToRoll = db
    .prepare(`
      SELECT DISTINCT date(captured_at) AS day
      FROM linkedin_post_metrics
      WHERE date(captured_at) < date('now')
        AND date(captured_at) NOT IN (SELECT day FROM linkedin_post_metrics_daily)
      ORDER BY day
    `)
    .all() as Array<{ day: string }>

  const rollupStmt = db.prepare(`
    INSERT OR REPLACE INTO linkedin_post_metrics_daily
      (post_id, day, impressions, likes, comments, shares)
    SELECT post_id,
           date(captured_at) AS day,
           MAX(impressions) AS impressions,
           MAX(likes) AS likes,
           MAX(comments) AS comments,
           MAX(shares) AS shares
    FROM linkedin_post_metrics
    WHERE date(captured_at) = ?
    GROUP BY post_id
  `)

  let daysRolled = 0
  for (const { day } of daysToRoll) {
    rollupStmt.run(day)
    daysRolled += 1
  }

  const pruneInfo = db
    .prepare(
      `DELETE FROM linkedin_post_metrics WHERE captured_at < datetime('now', ?)`,
    )
    .run(`-${RETENTION_DAYS} days`)

  db.prepare(
    `UPDATE linkedin_metrics_runs SET
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

export function lastRollupAt(): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(finished_at) AS last_run FROM linkedin_metrics_runs
       WHERE kind = 'rollup' AND finished_at IS NOT NULL`,
    )
    .get() as { last_run: string | null } | undefined
  return row?.last_run ?? null
}
