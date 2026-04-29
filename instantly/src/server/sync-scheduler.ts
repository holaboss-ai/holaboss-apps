import { isSyncEnabled, syncOutreach } from "./sync"

const SYNC_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const BOOT_DELAY_MS = 25_000

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

  console.log("[sync] instantly scheduler started (every 30min)")
}

async function runSyncTick(): Promise<void> {
  if (!isSyncEnabled()) return
  try {
    const result = await syncOutreach({})
    const summary = result.per_object
      .map(
        (r) =>
          `${r.object_slug}=${r.records_inserted}+${r.records_updated}/${r.records_seen}`,
      )
      .join(" ")
    console.log(
      `[sync] instantly ${summary}` +
        `${result.rate_limited ? " (rate-limited)" : ""}`,
    )
  } catch (err) {
    console.error("[sync] instantly tick failed:", err)
  }
}
