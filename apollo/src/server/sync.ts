import type Database from "better-sqlite3"

import { apiPost } from "./apollo-client"
import { getDb } from "./db"

// Apollo outreach mirror — campaigns (sequences) + the contacts on
// them. Apollo's pagination is page-based.
//
// Endpoints:
//   POST /emailer_campaigns/search  — list campaigns
//     body: { page, per_page, query }
//   POST /contacts/search           — list contacts
//     body: { page, per_page, sort_by_field: "contact_last_activity_date" }
//
// The contacts endpoint returns the user's owned contacts, including
// each contact's `emailer_campaign_ids` and reply state.

const PAGE_LIMIT = 100
const MAX_PAGES = 50 // 5000 records per object per run

interface ApolloCampaign {
  id: string
  name?: string | null
  label?: string | null
  status?: string | null
  num_steps?: number
  active_in_emailer?: boolean
  num_contacts?: number
  created_at?: string | null
  updated_at?: string | null
}

interface ApolloContact {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  title?: string | null
  organization_name?: string | null
  account_name?: string | null
  emailer_campaign_ids?: string[]
  email_replied?: boolean
  created_at?: string | null
  updated_at?: string | null
}

interface CampaignsSearchResponse {
  emailer_campaigns?: ApolloCampaign[]
  pagination?: { page?: number; per_page?: number; total_pages?: number }
}

interface ContactsSearchResponse {
  contacts?: ApolloContact[]
  pagination?: { page?: number; per_page?: number; total_pages?: number }
}

export interface SyncOpts {
  full?: boolean
}

export interface ObjectSyncResult {
  object_slug: "campaigns" | "contacts"
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

  for (const slug of ["campaigns", "contacts"] as const) {
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
  slug: "campaigns" | "contacts",
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
        "INSERT INTO apollo_sync_runs (started_at, kind, object_slug) VALUES (?, ?, ?)",
      )
      .run(startedAt, kind, slug).lastInsertRowid,
  )

  try {
    const lastSynced = full ? null : readLastSynced(db, slug)
    let maxUpdatedAt = lastSynced

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const endpoint =
        slug === "campaigns" ? "/emailer_campaigns/search" : "/contacts/search"
      const body: Record<string, unknown> = {
        page,
        per_page: PAGE_LIMIT,
      }
      if (slug === "contacts") {
        body.sort_by_field = "contact_last_activity_date"
        body.sort_ascending = false
      }

      const r = await apiPost<CampaignsSearchResponse | ContactsSearchResponse>(endpoint, body)
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

      const records: Array<ApolloCampaign | ApolloContact> =
        slug === "campaigns"
          ? (r.data as CampaignsSearchResponse).emailer_campaigns ?? []
          : (r.data as ContactsSearchResponse).contacts ?? []
      if (records.length === 0) break

      let stopEarly = false
      for (const rec of records) {
        if (!rec.id) {
          result.errors.push({ record_id: "(missing)", error: "no id" })
          continue
        }
        result.records_seen += 1

        // Incremental cutoff: contacts come sorted by activity desc, so once we
        // hit a record older than last_synced we can stop.
        if (
          !full &&
          slug === "contacts" &&
          lastSynced &&
          rec.updated_at &&
          rec.updated_at <= lastSynced
        ) {
          stopEarly = true
          break
        }

        try {
          const action =
            slug === "campaigns"
              ? upsertCampaign(db, rec as ApolloCampaign)
              : upsertContact(db, rec as ApolloContact)
          if (action === "inserted") result.records_inserted += 1
          else if (action === "updated") result.records_updated += 1

          if (rec.updated_at && (!maxUpdatedAt || rec.updated_at > maxUpdatedAt)) {
            maxUpdatedAt = rec.updated_at
          }
        } catch (err) {
          result.errors.push({
            record_id: rec.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (stopEarly) break
      const totalPages =
        slug === "campaigns"
          ? (r.data as CampaignsSearchResponse).pagination?.total_pages
          : (r.data as ContactsSearchResponse).pagination?.total_pages
      if (totalPages != null && page >= totalPages) break
      if (records.length < PAGE_LIMIT) break
    }

    if (maxUpdatedAt && maxUpdatedAt !== lastSynced) {
      writeLastSynced(db, slug, maxUpdatedAt)
    }
    finishRun(db, runId, result)
    return { object_slug: slug, run_id: runId, ...result }
  } catch (err) {
    finishRun(db, runId, result, err instanceof Error ? err.message : String(err))
    throw err
  }
}

export function isSyncEnabled(): boolean {
  const row = getDb()
    .prepare("SELECT value FROM apollo_settings WHERE key = 'sync_enabled'")
    .get() as { value: string } | undefined
  return row ? row.value !== "0" : true
}

export function setSyncEnabled(enabled: boolean): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO apollo_settings (key, value, updated_at)
     VALUES ('sync_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(enabled ? "1" : "0")
}

function readLastSynced(db: Database.Database, slug: string): string | null {
  const row = db
    .prepare("SELECT value FROM apollo_settings WHERE key = ?")
    .get(`last_synced_${slug}`) as { value: string } | undefined
  return row?.value ?? null
}

function writeLastSynced(db: Database.Database, slug: string, ts: string): void {
  db.prepare(
    `INSERT INTO apollo_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(`last_synced_${slug}`, ts)
}

function upsertCampaign(db: Database.Database, c: ApolloCampaign): "inserted" | "updated" {
  return upsertGeneric(
    db,
    "apollo_campaigns",
    [
      "record_id",
      "name",
      "label",
      "status",
      "num_steps",
      "num_contacts",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      c.id,
      c.name ?? null,
      c.label ?? null,
      c.status ?? (c.active_in_emailer ? "active" : null),
      c.num_steps ?? null,
      c.num_contacts ?? null,
      JSON.stringify(c),
      c.created_at ?? null,
      c.updated_at ?? null,
    ],
  )
}

function upsertContact(db: Database.Database, c: ApolloContact): "inserted" | "updated" {
  const campaignId = (c.emailer_campaign_ids ?? [])[0] ?? null
  return upsertGeneric(
    db,
    "apollo_contacts",
    [
      "record_id",
      "first_name",
      "last_name",
      "email",
      "title",
      "company_name",
      "campaign_id",
      "replied",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      c.id,
      c.first_name ?? null,
      c.last_name ?? null,
      c.email ?? null,
      c.title ?? null,
      c.organization_name ?? c.account_name ?? null,
      campaignId,
      c.email_replied ? 1 : 0,
      JSON.stringify(c),
      c.created_at ?? null,
      c.updated_at ?? null,
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
    `UPDATE apollo_sync_runs SET
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
    `INSERT INTO apollo_api_usage (date, ${column}, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       ${column} = ${column} + excluded.${column},
       updated_at = datetime('now')`,
  ).run(today, delta)
}
