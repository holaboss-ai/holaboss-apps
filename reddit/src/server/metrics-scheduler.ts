import { isMetricsRefreshEnabled, refreshPostMetrics } from "./metrics"

const REFRESH_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const REFRESH_BOOT_DELAY_MS = 15_000

let started = false

// Reddit's monitoring runs on a hard 4h x 12 milestone schedule per
// post. The scheduler still ticks every 5 minutes, but the refresh
// function decides which posts have actually crossed a milestone
// boundary — so most ticks no-op. Idempotent so a hot-reloaded
// services process doesn't double up timers.
export function startMetricsScheduler(): void {
  if (started) return
  started = true

  setTimeout(() => {
    void runRefreshTick()
  }, REFRESH_BOOT_DELAY_MS)
  setInterval(() => {
    void runRefreshTick()
  }, REFRESH_INTERVAL_MS)

  console.log("[metrics] reddit scheduler started (5min tick, 4h x 12 capture milestones)")
}

async function runRefreshTick(): Promise<void> {
  if (!isMetricsRefreshEnabled()) {
    return
  }
  try {
    const result = await refreshPostMetrics({})
    console.log(
      `[metrics] reddit refresh run=${result.run_id} ` +
        `considered=${result.posts_considered} ` +
        `refreshed=${result.posts_refreshed} ` +
        `skipped=${result.posts_skipped} ` +
        `deleted=${result.posts_deleted} ` +
        `completed=${result.posts_completed} ` +
        `errors=${result.errors.length}` +
        `${result.rate_limited ? " (rate-limited)" : ""}`,
    )
  } catch (err) {
    console.error("[metrics] reddit refresh tick failed:", err)
  }
}
