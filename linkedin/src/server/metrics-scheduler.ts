import { isMetricsRefreshEnabled, refreshPostMetrics } from "./metrics"
import { lastRollupAt, rollupAndPrune } from "./metrics-rollup"

const REFRESH_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const ROLLUP_CHECK_INTERVAL_MS = 60 * 60 * 1000 // hourly probe
const ROLLUP_DUE_AFTER_MS = 23 * 60 * 60 * 1000 // ~24h between rollups
const REFRESH_BOOT_DELAY_MS = 15_000
const ROLLUP_BOOT_DELAY_MS = 60_000

let started = false

export function startMetricsScheduler(): void {
  if (started) return
  started = true

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

  console.log("[metrics] linkedin scheduler started (refresh every 5min, rollup ~24h)")
}

async function runRefreshTick(): Promise<void> {
  if (!isMetricsRefreshEnabled()) return
  try {
    const result = await refreshPostMetrics({})
    console.log(
      `[metrics] linkedin refresh run=${result.run_id} ` +
        `considered=${result.posts_considered} ` +
        `refreshed=${result.posts_refreshed} ` +
        `skipped=${result.posts_skipped} ` +
        `deleted=${result.posts_deleted} ` +
        `errors=${result.errors.length}` +
        `${result.rate_limited ? " (rate-limited)" : ""}`,
    )
  } catch (err) {
    console.error("[metrics] linkedin refresh tick failed:", err)
  }
}

async function runRollupTick(): Promise<void> {
  const last = lastRollupAt()
  if (last) {
    const sinceMs = Date.now() - new Date(last).getTime()
    if (sinceMs < ROLLUP_DUE_AFTER_MS) return
  }
  try {
    const result = rollupAndPrune()
    console.log(
      `[metrics] linkedin rollup run=${result.run_id} ` +
        `days_rolled=${result.days_rolled} rows_pruned=${result.rows_pruned}`,
    )
  } catch (err) {
    console.error("[metrics] linkedin rollup tick failed:", err)
  }
}
