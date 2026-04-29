import { isSyncEnabled, syncBookings } from "./sync"

const SYNC_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes
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

  console.log("[sync] calcom scheduler started (every 15min, incremental)")
}

async function runSyncTick(): Promise<void> {
  if (!isSyncEnabled()) return
  try {
    const result = await syncBookings({})
    console.log(
      `[sync] calcom run=${result.run_id} ` +
        `seen=${result.bookings_seen} ` +
        `inserted=${result.bookings_inserted} ` +
        `updated=${result.bookings_updated} ` +
        `errors=${result.errors.length}` +
        `${result.rate_limited ? " (rate-limited)" : ""}`,
    )
  } catch (err) {
    console.error("[sync] calcom tick failed:", err)
  }
}
