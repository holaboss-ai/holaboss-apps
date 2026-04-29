import type Database from "better-sqlite3"

import { apiGet, apiPost } from "./instantly-client"
import { getDb } from "./db"

// Instantly outreach mirror — campaigns + leads. Cursor-based
// pagination via `starting_after` (Instantly v2 convention).
//
// Endpoints:
//   GET  /campaigns?limit=100&starting_after=<cursor>
//        → { items: [...], next_starting_after }
//   POST /leads/list  body: { limit, starting_after }
//        → { items: [...], next_starting_after }

const PAGE_LIMIT = 100
const MAX_PAGES = 50 // 5000 records per object per run

interface InstantlyCampaign {
  id: string
  name?: string | null
  status?: string | number | null
  sent_count?: number
  open_count?: number
  reply_count?: number
  bounce_count?: number
  timestamp_created?: string | null
  timestamp_updated?: string | null
}

interface InstantlyLead {
  id: string
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  company_name?: string | null
  status?: string | number | null
  campaign?: string | null
  timestamp_created?: string | null
  timestamp_updated?: string | null
}

interface PageResponse<T> {
  items?: T[]
  next_starting_after?: string | null
}

export interface SyncOpts {
  full?: boolean
}

export interface ObjectSyncResult {
  object_slug: "campaigns" | "leads"
  run_id: number
  records_seen: number
  records_inserted: number
  records_updated: number
  errors: Array<{ record_id: string; error: string }>
  rate_limited: boolean
}

export interface SyncResult {
  per_object: ObjectSyncResult[]
  total_inserted: number
  total_updated: number
  rate_limited: boolean
}

export async function syncOutreach(opts: SyncOpts = {}): Promise<SyncResult> {
  const per_object: ObjectSyncResult[] = []
  let total_inserted = 0
  let total_updated = 0
  let rate_limited = false

  for (const slug of ["campaigns", "leads"] as const) {
    const r = await syncObject(slug, opts.full ?? false)
    per_object.push(r)
    total_inserted += r.records_inserted
    total_updated += r.records_updated
    if (r.rate_limited) {
      rate_limited = true
      break
    }
  }

  return { per_object, total_inserted, total_updated, rate_limited }
}

async function syncObject(
  slug: "campaigns" | "leads",
  full: boolean,
): Promise<ObjectSyncResult> {
  const db = getDb()
  const startedAt = new Date().toISOString()
  const kind = full ? "full" : "incremental"
  const result: Omit<ObjectSyncResult, "run_id" | "object_slug"> = {
    records_seen: 0,
    records_inserted: 0,
    records_updated: 0,
    errors: [],
    rate_limited: false,
  }

  const runId = Number(
    db
      .prepare(
        "INSERT INTO instantly_sync_runs (started_at, kind, object_slug) VALUES (?, ?, ?)",
      )
      .run(startedAt, kind, slug).lastInsertRowid,
  )

  try {
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const r = await fetchPage(slug, cursor)
      if (!r.ok) {
        if (r.error.code === "rate_limited") {
          result.rate_limited = true
          incrementUsage(db, "calls_rate_limited", 1)
          break
        }
        incrementUsage(db, "calls_failed", 1)
        result.errors.push({ record_id: "(list)", error: r.error.message })
        break
      }
      incrementUsage(db, "calls_succeeded", 1)

      const items = r.data?.items ?? []
      if (items.length === 0) break

      for (const rec of items as Array<InstantlyCampaign | InstantlyLead>) {
        if (!rec.id) {
          result.errors.push({ record_id: "(missing)", error: "no id" })
          continue
        }
        result.records_seen += 1
        try {
          const action =
            slug === "campaigns"
              ? upsertCampaign(db, rec as InstantlyCampaign)
              : upsertLead(db, rec as InstantlyLead)
          if (action === "inserted") result.records_inserted += 1
          else if (action === "updated") result.records_updated += 1
        } catch (err) {
          result.errors.push({
            record_id: rec.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      cursor = r.data?.next_starting_after ?? null
      if (!cursor) break
    }

    finishRun(db, runId, result)
    return { object_slug: slug, run_id: runId, ...result }
  } catch (err) {
    finishRun(db, runId, result, err instanceof Error ? err.message : String(err))
    throw err
  }
}

async function fetchPage(slug: "campaigns" | "leads", cursor: string | null) {
  if (slug === "campaigns") {
    const params = new URLSearchParams()
    params.set("limit", String(PAGE_LIMIT))
    if (cursor) params.set("starting_after", cursor)
    return apiGet<PageResponse<InstantlyCampaign>>(`/campaigns?${params.toString()}`)
  }
  const body: Record<string, unknown> = { limit: PAGE_LIMIT }
  if (cursor) body.starting_after = cursor
  return apiPost<PageResponse<InstantlyLead>>("/leads/list", body)
}

export function isSyncEnabled(): boolean {
  const row = getDb()
    .prepare("SELECT value FROM instantly_settings WHERE key = 'sync_enabled'")
    .get() as { value: string } | undefined
  return row ? row.value !== "0" : true
}

export function setSyncEnabled(enabled: boolean): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO instantly_settings (key, value, updated_at)
     VALUES ('sync_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(enabled ? "1" : "0")
}

function upsertCampaign(
  db: Database.Database,
  c: InstantlyCampaign,
): "inserted" | "updated" {
  return upsertGeneric(
    db,
    "instantly_campaigns",
    [
      "record_id",
      "name",
      "status",
      "sent_count",
      "open_count",
      "reply_count",
      "bounce_count",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      c.id,
      c.name ?? null,
      c.status != null ? String(c.status) : null,
      c.sent_count ?? null,
      c.open_count ?? null,
      c.reply_count ?? null,
      c.bounce_count ?? null,
      JSON.stringify(c),
      c.timestamp_created ?? null,
      c.timestamp_updated ?? null,
    ],
  )
}

function upsertLead(db: Database.Database, l: InstantlyLead): "inserted" | "updated" {
  return upsertGeneric(
    db,
    "instantly_leads",
    [
      "record_id",
      "email",
      "first_name",
      "last_name",
      "company",
      "status",
      "campaign_id",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      l.id,
      l.email ?? null,
      l.first_name ?? null,
      l.last_name ?? null,
      l.company_name ?? null,
      l.status != null ? String(l.status) : null,
      l.campaign ?? null,
      JSON.stringify(l),
      l.timestamp_created ?? null,
      l.timestamp_updated ?? null,
    ],
  )
}

function upsertGeneric(
  db: Database.Database,
  table: string,
  cols: string[],
  vals: (string | number | null | undefined)[],
): "inserted" | "updated" {
  const existing = db
    .prepare(`SELECT record_id FROM ${table} WHERE record_id = ?`)
    .get(vals[0]) as { record_id: string } | undefined
  if (existing) {
    const setClause = cols
      .slice(1)
      .map((c) => `${c} = ?`)
      .concat(["synced_at = datetime('now')"])
      .join(", ")
    db.prepare(
      `UPDATE ${table} SET ${setClause} WHERE record_id = ?`,
    ).run(...vals.slice(1), vals[0])
    return "updated"
  }
  const placeholders = cols.map(() => "?").join(", ")
  db.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}, synced_at) VALUES (${placeholders}, datetime('now'))`,
  ).run(...vals)
  return "inserted"
}

function finishRun(
  db: Database.Database,
  runId: number,
  result: Omit<ObjectSyncResult, "run_id" | "object_slug">,
  errorMessage: string | null = null,
): void {
  const errorsPayload = errorMessage
    ? JSON.stringify([{ error: errorMessage }, ...result.errors])
    : result.errors.length > 0
      ? JSON.stringify(result.errors)
      : null
  db.prepare(
    `UPDATE instantly_sync_runs SET
       finished_at = datetime('now'),
       records_seen = ?,
       records_inserted = ?,
       records_updated = ?,
       errors_json = ?
     WHERE id = ?`,
  ).run(
    result.records_seen,
    result.records_inserted,
    result.records_updated,
    errorsPayload,
    runId,
  )
}

function incrementUsage(
  db: Database.Database,
  column: "calls_succeeded" | "calls_failed" | "calls_rate_limited",
  delta: number,
): void {
  const today = new Date().toISOString().slice(0, 10)
  db.prepare(
    `INSERT INTO instantly_api_usage (date, ${column}, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       ${column} = ${column} + excluded.${column},
       updated_at = datetime('now')`,
  ).run(today, delta)
}
