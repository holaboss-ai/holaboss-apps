import type Database from "better-sqlite3"

import { apiPost } from "./hubspot-client"
import { getDb } from "./db"

// HubSpot CRM sync — same shape as the Attio mirror but talking to
// HubSpot's CRM v3 search endpoint. Standard objects only:
// contacts, companies, deals.
//
// Endpoint: POST /crm/v3/objects/<slug>/search
//   body: {
//     filterGroups, sorts: [{ propertyName, direction }],
//     after, limit, properties: [...]
//   }
//
// Strategy:
//   - incremental: filter `lastmodifieddate > last_sync_<slug>` (ms
//     since epoch). Catches edits + new records, NOT deletions.
//   - full: paginate via /list endpoint (after cursor), capped at
//     5000 per object. Detects deletions.

const PAGE_LIMIT = 100
const MAX_PAGES = 50 // 5000 records per object per run
const SYNCABLE_OBJECTS = ["contacts", "companies", "deals"] as const
type ObjectSlug = (typeof SYNCABLE_OBJECTS)[number]

const PROPERTIES_BY_OBJECT: Record<ObjectSlug, string[]> = {
  contacts: [
    "firstname",
    "lastname",
    "email",
    "phone",
    "company",
    "jobtitle",
    "lifecyclestage",
    "createdate",
    "lastmodifieddate",
  ],
  companies: [
    "name",
    "domain",
    "industry",
    "numberofemployees",
    "annualrevenue",
    "createdate",
    "hs_lastmodifieddate",
  ],
  deals: [
    "dealname",
    "dealstage",
    "pipeline",
    "amount",
    "closedate",
    "hubspot_owner_id",
    "createdate",
    "hs_lastmodifieddate",
  ],
}

const LAST_MODIFIED_PROP: Record<ObjectSlug, string> = {
  contacts: "lastmodifieddate",
  companies: "hs_lastmodifieddate",
  deals: "hs_lastmodifieddate",
}

interface HubspotRecord {
  id: string
  properties?: Record<string, string | null>
  createdAt?: string
  updatedAt?: string
}

interface SearchResponse {
  results?: HubspotRecord[]
  paging?: { next?: { after?: string } }
  total?: number
}

export interface SyncOpts {
  full?: boolean
  objects?: ObjectSlug[]
}

export interface ObjectSyncResult {
  object_slug: ObjectSlug
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

export async function syncCrm(opts: SyncOpts = {}): Promise<SyncResult> {
  const objects = opts.objects ?? [...SYNCABLE_OBJECTS]
  const per_object: ObjectSyncResult[] = []
  let total_inserted = 0
  let total_updated = 0
  let rate_limited = false

  for (const slug of objects) {
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

async function syncObject(slug: ObjectSlug, full: boolean): Promise<ObjectSyncResult> {
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
        "INSERT INTO hubspot_sync_runs (started_at, kind, object_slug) VALUES (?, ?, ?)",
      )
      .run(startedAt, kind, slug).lastInsertRowid,
  )

  try {
    const lastSyncedMs = full ? null : readLastSyncedMs(db, slug)
    const modifiedProp = LAST_MODIFIED_PROP[slug]
    let maxModifiedMs = lastSyncedMs ?? 0

    let after: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        properties: PROPERTIES_BY_OBJECT[slug],
        sorts: [{ propertyName: modifiedProp, direction: "ASCENDING" }],
        limit: PAGE_LIMIT,
      }
      if (after) body.after = after
      if (!full && lastSyncedMs != null) {
        body.filterGroups = [
          {
            filters: [
              {
                propertyName: modifiedProp,
                operator: "GT",
                value: String(lastSyncedMs),
              },
            ],
          },
        ]
      }

      const r = await apiPost<SearchResponse>(`/crm/v3/objects/${slug}/search`, body)
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

      const records = r.data?.results ?? []
      if (records.length === 0) break

      for (const rec of records) {
        if (!rec.id) {
          result.errors.push({ record_id: "(missing)", error: "no id" })
          continue
        }
        result.records_seen += 1
        try {
          const action = upsertRecord(db, slug, rec)
          if (action === "inserted") result.records_inserted += 1
          else if (action === "updated") result.records_updated += 1

          const modifiedRaw = rec.properties?.[modifiedProp]
          const modifiedMs = parseHubspotTimestamp(modifiedRaw ?? rec.updatedAt)
          if (modifiedMs && modifiedMs > maxModifiedMs) maxModifiedMs = modifiedMs
        } catch (err) {
          result.errors.push({
            record_id: rec.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      after = r.data?.paging?.next?.after
      if (!after || records.length < PAGE_LIMIT) break
    }

    if (maxModifiedMs && maxModifiedMs !== lastSyncedMs) {
      writeLastSyncedMs(db, slug, maxModifiedMs)
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
    .prepare("SELECT value FROM hubspot_settings WHERE key = 'sync_enabled'")
    .get() as { value: string } | undefined
  return row ? row.value !== "0" : true
}

export function setSyncEnabled(enabled: boolean): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO hubspot_settings (key, value, updated_at)
     VALUES ('sync_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(enabled ? "1" : "0")
}

function readLastSyncedMs(db: Database.Database, slug: ObjectSlug): number | null {
  const row = db
    .prepare("SELECT value FROM hubspot_settings WHERE key = ?")
    .get(`last_synced_${slug}_ms`) as { value: string } | undefined
  if (!row) return null
  const n = Number(row.value)
  return Number.isFinite(n) ? n : null
}

function writeLastSyncedMs(db: Database.Database, slug: ObjectSlug, ms: number): void {
  db.prepare(
    `INSERT INTO hubspot_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(`last_synced_${slug}_ms`, String(ms))
}

function parseHubspotTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null
  // HubSpot returns lastmodifieddate either as ISO string or as ms-since-epoch numeric string.
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function upsertRecord(
  db: Database.Database,
  slug: ObjectSlug,
  rec: HubspotRecord,
): "inserted" | "updated" {
  if (slug === "contacts") return upsertContact(db, rec)
  if (slug === "companies") return upsertCompany(db, rec)
  return upsertDeal(db, rec)
}

function upsertContact(db: Database.Database, rec: HubspotRecord): "inserted" | "updated" {
  const p = rec.properties ?? {}
  return upsertGeneric(
    db,
    "hubspot_contacts",
    [
      "record_id",
      "first_name",
      "last_name",
      "email",
      "phone",
      "company",
      "job_title",
      "lifecycle_stage",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      rec.id,
      p.firstname ?? null,
      p.lastname ?? null,
      p.email ?? null,
      p.phone ?? null,
      p.company ?? null,
      p.jobtitle ?? null,
      p.lifecyclestage ?? null,
      JSON.stringify(rec),
      rec.createdAt ?? null,
      rec.updatedAt ?? null,
    ],
  )
}

function upsertCompany(db: Database.Database, rec: HubspotRecord): "inserted" | "updated" {
  const p = rec.properties ?? {}
  return upsertGeneric(
    db,
    "hubspot_companies",
    [
      "record_id",
      "name",
      "domain",
      "industry",
      "employee_count",
      "annual_revenue",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      rec.id,
      p.name ?? null,
      p.domain ?? null,
      p.industry ?? null,
      parseNumeric(p.numberofemployees),
      parseNumeric(p.annualrevenue),
      JSON.stringify(rec),
      rec.createdAt ?? null,
      rec.updatedAt ?? null,
    ],
  )
}

function upsertDeal(db: Database.Database, rec: HubspotRecord): "inserted" | "updated" {
  const p = rec.properties ?? {}
  return upsertGeneric(
    db,
    "hubspot_deals",
    [
      "record_id",
      "name",
      "stage",
      "pipeline",
      "amount",
      "close_date",
      "owner_id",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      rec.id,
      p.dealname ?? null,
      p.dealstage ?? null,
      p.pipeline ?? null,
      parseNumeric(p.amount),
      p.closedate ?? null,
      p.hubspot_owner_id ?? null,
      JSON.stringify(rec),
      rec.createdAt ?? null,
      rec.updatedAt ?? null,
    ],
  )
}

function parseNumeric(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
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
    `UPDATE hubspot_sync_runs SET
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
    `INSERT INTO hubspot_api_usage (date, ${column}, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       ${column} = ${column} + excluded.${column},
       updated_at = datetime('now')`,
  ).run(today, delta)
}
