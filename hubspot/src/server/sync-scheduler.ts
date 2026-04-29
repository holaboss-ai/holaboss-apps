import { isSyncEnabled, syncCrm } from "./sync"

const SYNC_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const FULL_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000 // daily full re-paginate
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

  console.log("[sync] hubspot scheduler started (30min incremental, daily full)")
}

async function runSyncTick(): Promise<void> {
  if (!isSyncEnabled()) return
  const now = Date.now()
  const dueFull = now - lastFullReconcileAt >= FULL_RECONCILE_INTERVAL_MS
  try {
    const result = await syncCrm({ full: dueFull })
    if (dueFull) lastFullReconcileAt = now
    const summary = result.per_object
      .map(
        (r) =>
          `${r.object_slug}=${r.records_inserted}+${r.records_updated}/${r.records_seen}`,
      )
      .join(" ")
    console.log(
      `[sync] hubspot kind=${dueFull ? "full" : "incremental"} ${summary}` +
        `${result.rate_limited ? " (rate-limited)" : ""}`,
    )
  } catch (err) {
    console.error("[sync] hubspot tick failed:", err)
  }
}
