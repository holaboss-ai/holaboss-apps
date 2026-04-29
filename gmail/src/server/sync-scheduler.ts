import { isSyncEnabled, syncThreads } from "./sync"

const SYNC_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes — email moves faster than CRMs
const BOOT_DELAY_MS = 20_000

let started = false

export function startSyncScheduler(): void {
  if (started) return
  started = true

  setTimeout(() => {
    void runSyncTick()
  }, BOOT_DELAY_MS)
  setInterval(() => {
    void runSyncTick()
  }, SYNC_INTERVAL_MS)

  console.log("[sync] gmail scheduler started (every 15min, last 30 days window)")
}

async function runSyncTick(): Promise<void> {
  if (!isSyncEnabled()) return
  try {
    const result = await syncThreads({})
    console.log(
      `[sync] gmail run=${result.run_id} ` +
        `seen=${result.threads_seen} ` +
        `fetched=${result.threads_fetched} ` +
        `inserted=${result.threads_inserted} ` +
        `updated=${result.threads_updated} ` +
        `errors=${result.errors.length}` +
        `${result.rate_limited ? " (rate-limited)" : ""}`,
    )
  } catch (err) {
    console.error("[sync] gmail tick failed:", err)
  }
}
