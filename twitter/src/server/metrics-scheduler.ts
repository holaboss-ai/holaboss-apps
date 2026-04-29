import { isMetricsRefreshEnabled, refreshPostMetrics } from "./metrics"
import { lastRollupAt, rollupAndPrune } from "./metrics-rollup"

const REFRESH_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const ROLLUP_CHECK_INTERVAL_MS = 60 * 60 * 1000 // hourly probe
const ROLLUP_DUE_AFTER_MS = 23 * 60 * 60 * 1000 // act if last rollup > ~23h ago
const REFRESH_BOOT_DELAY_MS = 15_000
const ROLLUP_BOOT_DELAY_MS = 60_000

let started = false

// Kicks off the in-process metrics scheduler — one 5-minute interval
// for refresh and one hourly probe that runs the daily rollup when
// it's been ~24h since the last successful one. Idempotent: calling
// twice is a no-op so a hot-reloaded services process doesn't double
// up timers.
export function startMetricsScheduler(): void {
  if (started) return
  started = true

  // Stagger boot so we don't collide with the publish queue's own
  // initial tick or with workspace-level startup work.
  setTimeout(() => {
    void runRefreshTick()
  }, REFRESH_BOOT_DELAY_MS)
  setInterval(() => {
    void runRefreshTick()
  }, REFRESH_INTERVAL_MS)

  setTimeout(() => {
    void runRollupTick()
  }, ROLLUP_BOOT_DELAY_MS)
  setInterval(() => {
    void runRollupTick()
  }, ROLLUP_CHECK_INTERVAL_MS)

  console.log("[metrics] scheduler started (refresh every 5min, rollup ~24h)")
}

async function runRefreshTick(): Promise<void> {
  if (!isMetricsRefreshEnabled()) {
    // Pause flag is on. Skip the run silently — the runs log will
    // simply have a gap, which is the expected signal that it's paused.
    return
  }
  try {
    const result = await refreshPostMetrics({})
    console.log(
      `[metrics] refresh run=${result.run_id} ` +
        `considered=${result.posts_considered} ` +
        `refreshed=${result.posts_refreshed} ` +
        `skipped=${result.posts_skipped} ` +
        `deleted=${result.posts_deleted} ` +
        `errors=${result.errors.length}` +
        `${result.rate_limited ? " (rate-limited)" : ""}`,
    )
  } catch (err) {
    console.error("[metrics] refresh tick failed:", err)
  }
}

async function runRollupTick(): Promise<void> {
  // Rollup runs regardless of metrics_refresh_enabled — it operates on
  // already-captured rows; pausing refresh shouldn't pause aggregation
  // of what's already there.
  const last = lastRollupAt()
  if (last) {
    const sinceMs = Date.now() - new Date(last).getTime()
    if (sinceMs < ROLLUP_DUE_AFTER_MS) return
  }
  try {
    const result = rollupAndPrune()
    console.log(
      `[metrics] rollup run=${result.run_id} ` +
        `days_rolled=${result.days_rolled} rows_pruned=${result.rows_pruned}`,
    )
  } catch (err) {
    console.error("[metrics] rollup tick failed:", err)
  }
}
