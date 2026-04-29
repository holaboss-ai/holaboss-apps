import type Database from "better-sqlite3"

import { apiPost } from "./attio-client"
import { getDb } from "./db"

// Attio is a CRM — slow-changing relative to Twitter/LinkedIn metrics.
// Sync ticks every 30 minutes against the three standard objects
// (people, companies, deals). Workspace-customized objects are not
// mirrored; they remain accessible via attio_query_records / live
// tools that proxy to Attio directly.
//
// Strategy:
//   - incremental (default): filter `updated_at > last_synced_at`,
//     paginate. Catches edits + new records but NOT deletions.
//   - full: omit filter, paginate everything (capped at 5000 rows
//     per object). Used on first run and once a day to reconcile
//     deletions.
//
// Attio uses POST /v2/objects/<slug>/records/query with body:
//   { filter, limits, sorts: [...] }

const PAGE_SIZE = 500
const MAX_PAGES = 10 // 5000 records per object per run
const SYNCABLE_OBJECTS = ["people", "companies", "deals"] as const
type ObjectSlug = (typeof SYNCABLE_OBJECTS)[number]

type RawRecord = Record<string, unknown>

interface QueryResponse {
  data?: RawRecord[]
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
        "INSERT INTO attio_sync_runs (started_at, kind, object_slug) VALUES (?, ?, ?)",
      )
      .run(startedAt, kind, slug).lastInsertRowid,
  )

  try {
    const lastSynced = full ? null : readLastSynced(db, slug)
    let maxUpdatedAt: string | null = lastSynced

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        sorts: [{ attribute: "updated_at", direction: "asc" }],
      }
      if (lastSynced) {
        body.filter = { updated_at: { $gt: lastSynced } }
      }

      const r = await apiPost<QueryResponse>(`/objects/${slug}/records/query`, body)
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

      const records = r.data?.data ?? []
      if (records.length === 0) break

      for (const raw of records) {
        const recordId = extractRecordId(raw)
        if (!recordId) {
          result.errors.push({ record_id: "(missing)", error: "no record_id" })
          continue
        }
        result.records_seen += 1
        try {
          const action = upsertRecord(db, slug, recordId, raw)
          if (action === "inserted") result.records_inserted += 1
          else if (action === "updated") result.records_updated += 1

          const updatedAt = String(raw.updated_at ?? "")
          if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) {
            maxUpdatedAt = updatedAt
          }
        } catch (err) {
          result.errors.push({
            record_id: recordId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (records.length < PAGE_SIZE) break
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
    .prepare("SELECT value FROM attio_settings WHERE key = 'sync_enabled'")
    .get() as { value: string } | undefined
  return row ? row.value !== "0" : true
}

export function setSyncEnabled(enabled: boolean): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO attio_settings (key, value, updated_at)
     VALUES ('sync_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(enabled ? "1" : "0")
}

function readLastSynced(db: Database.Database, slug: ObjectSlug): string | null {
  const row = db
    .prepare("SELECT value FROM attio_settings WHERE key = ?")
    .get(`last_synced_${slug}`) as { value: string } | undefined
  return row?.value ?? null
}

function writeLastSynced(db: Database.Database, slug: ObjectSlug, ts: string): void {
  db.prepare(
    `INSERT INTO attio_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(`last_synced_${slug}`, ts)
}

function extractRecordId(raw: RawRecord): string | null {
  const id = raw.id
  if (id && typeof id === "object" && "record_id" in (id as Record<string, unknown>)) {
    const recId = (id as Record<string, unknown>).record_id
    if (typeof recId === "string") return recId
  }
  if (typeof id === "string") return id
  return null
}

function upsertRecord(
  db: Database.Database,
  slug: ObjectSlug,
  recordId: string,
  raw: RawRecord,
): "inserted" | "updated" {
  if (slug === "people") return upsertPerson(db, recordId, raw)
  if (slug === "companies") return upsertCompany(db, recordId, raw)
  return upsertDeal(db, recordId, raw)
}

function upsertPerson(
  db: Database.Database,
  recordId: string,
  raw: RawRecord,
): "inserted" | "updated" {
  const values = (raw.values as Record<string, unknown>) ?? {}
  const name = firstStringValue(values.name) ?? primitiveStringValue(values.name)
  const primaryEmail = firstAttr(values.email_addresses, "email_address")
  const primaryPhone = firstAttr(values.phone_numbers, "phone_number")
  const companyId = firstReferenceId(values.company)
  const jobTitle = firstStringValue(values.job_title) ?? primitiveStringValue(values.job_title)
  return upsertGeneric(
    db,
    "attio_people",
    [
      "record_id",
      "name",
      "primary_email",
      "primary_phone",
      "company_id",
      "job_title",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      recordId,
      name,
      primaryEmail,
      primaryPhone,
      companyId,
      jobTitle,
      JSON.stringify(raw),
      stringField(raw.created_at),
      stringField(raw.updated_at),
    ],
  )
}

function upsertCompany(
  db: Database.Database,
  recordId: string,
  raw: RawRecord,
): "inserted" | "updated" {
  const values = (raw.values as Record<string, unknown>) ?? {}
  const name = firstStringValue(values.name) ?? primitiveStringValue(values.name)
  const primaryDomain = firstAttr(values.domains, "domain")
  const industry = firstStringValue(values.industry) ?? primitiveStringValue(values.industry)
  const employeeCount = firstNumberValue(values.estimated_arr_usd ?? values.employee_count)
  return upsertGeneric(
    db,
    "attio_companies",
    [
      "record_id",
      "name",
      "primary_domain",
      "industry",
      "employee_count",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      recordId,
      name,
      primaryDomain,
      industry,
      employeeCount,
      JSON.stringify(raw),
      stringField(raw.created_at),
      stringField(raw.updated_at),
    ],
  )
}

function upsertDeal(
  db: Database.Database,
  recordId: string,
  raw: RawRecord,
): "inserted" | "updated" {
  const values = (raw.values as Record<string, unknown>) ?? {}
  const name = firstStringValue(values.name) ?? primitiveStringValue(values.name)
  const stage = firstStatusValue(values.stage)
  const valueAmount = firstNumberValue(values.value)
  const valueCurrency = firstAttr(values.value, "currency_code")
  const companyId = firstReferenceId(values.associated_company ?? values.company)
  const ownerId = firstReferenceId(values.owner)
  return upsertGeneric(
    db,
    "attio_deals",
    [
      "record_id",
      "name",
      "stage",
      "value_amount",
      "value_currency",
      "company_id",
      "owner_id",
      "raw",
      "created_at",
      "updated_at",
    ],
    [
      recordId,
      name,
      stage,
      valueAmount,
      valueCurrency,
      companyId,
      ownerId,
      JSON.stringify(raw),
      stringField(raw.created_at),
      stringField(raw.updated_at),
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

// Attio attribute values are arrays of typed objects. Helpers below
// pull the first useful primitive from common shapes:
//   name:           [{ value: "Acme" }] or [{ first_name, last_name }]
//   email_addresses:[{ email_address: "..." }]
//   stage:          [{ status: { title: "Won" } }]
//   value:          [{ value: 1234, currency_code: "USD" }]
//   company / owner:[{ target_record_id: "rec_..." }]

function firstStringValue(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null
  const first = field[0] as Record<string, unknown> | undefined
  if (!first) return null
  if (typeof first.value === "string") return first.value
  if (typeof first.full_name === "string") return first.full_name
  if (typeof first.first_name === "string" || typeof first.last_name === "string") {
    return [first.first_name, first.last_name].filter(Boolean).join(" ").trim() || null
  }
  return null
}

function primitiveStringValue(field: unknown): string | null {
  if (typeof field === "string") return field
  return null
}

function firstNumberValue(field: unknown): number | null {
  if (!Array.isArray(field) || field.length === 0) return null
  const first = field[0] as Record<string, unknown> | undefined
  if (!first) return null
  const v = first.value ?? first.amount
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function firstAttr(field: unknown, attr: string): string | null {
  if (!Array.isArray(field) || field.length === 0) return null
  const first = field[0] as Record<string, unknown> | undefined
  if (!first) return null
  const v = first[attr]
  return typeof v === "string" ? v : null
}

function firstStatusValue(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null
  const first = field[0] as Record<string, unknown> | undefined
  if (!first) return null
  const status = first.status as Record<string, unknown> | undefined
  if (status && typeof status.title === "string") return status.title
  if (typeof first.value === "string") return first.value
  return null
}

function firstReferenceId(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null
  const first = field[0] as Record<string, unknown> | undefined
  if (!first) return null
  const v = first.target_record_id
  return typeof v === "string" ? v : null
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null
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
    `UPDATE attio_sync_runs SET
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
    `INSERT INTO attio_api_usage (date, ${column}, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       ${column} = ${column} + excluded.${column},
       updated_at = datetime('now')`,
  ).run(today, delta)
}
