import { isSyncEnabled, syncOutreach } from "./sync"

const SYNC_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const FULL_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000
const BOOT_DELAY_MS = 25_000

let started = false
let lastFullReconcileAt = 0

export function startSyncScheduler(): void {
  if (started) return
  started = true

  setTimeout(() => {
    void runSyncTick()
  }, BOOT_DELAY_MS)
  setInterval(() => {
    void runSyncTick()
  }, SYNC_INTERVAL_MS)

  console.log("[sync] apollo scheduler started (30min incremental, daily full)")
}

async function runSyncTick(): Promise<void> {
  if (!isSyncEnabled()) return
  const now = Date.now()
  const dueFull = now - lastFullReconcileAt >= FULL_RECONCILE_INTERVAL_MS
  try {
    const result = await syncOutreach({ full: dueFull })
    if (dueFull) lastFullReconcileAt = now
    const summary = result.per_object
      .map(
        (r) =>
          `${r.object_slug}=${r.records_inserted}+${r.records_updated}/${r.records_seen}`,
      )
      .join(" ")
    console.log(
      `[sync] apollo kind=${dueFull ? "full" : "incremental"} ${summary}` +
        `${result.rate_limited ? " (rate-limited)" : ""}`,
    )
  } catch (err) {
    console.error("[sync] apollo tick failed:", err)
  }
}
