import type Database from "better-sqlite3"

import { apiGet } from "./calcom-client"
import { getDb } from "./db"

// Cal.com bookings are slow-changing data (a "calendar"), so we mirror
// them locally rather than round-tripping to Cal.com on every chat
// turn. The agent answers "what's on my calendar / who am I meeting /
// when am I free" by reading calcom_bookings directly.
//
// Strategy:
//   - incremental (default, every 15min): pull bookings with start >=
//     now - 30 days. This covers recent past meetings + everything
//     upcoming, which is the only window the agent reasons about.
//   - full (manual, or first run): paginate all bookings in pages of
//     100. Capped at MAX_FULL_PAGES * PAGE_SIZE = 5000 to bound the
//     per-run cost.
//
// Cal.com v2 bookings list endpoint accepts `take`, `skip`,
// `afterStart`, `status[]`. There is no `afterUpdatedAt` filter, so
// status changes on bookings older than 30 days are not detected by
// incremental sync — by design.

const PAGE_SIZE = 100
const MAX_FULL_PAGES = 50
const INCREMENTAL_LOOKBACK_DAYS = 30

type RawBooking = Record<string, unknown>

// Cal.com v2 documents the bookings list as { status, data: [...] } but
// some envelopes nest it under data.bookings, and the Composio broker
// can also return the items directly as an array. Handle all three.
type BookingsListResponse =
  | { data?: RawBooking[]; pagination?: { take?: number; skip?: number; total?: number } }
  | { data?: { bookings?: RawBooking[]; pagination?: unknown } }
  | RawBooking[]

function extractBookings(data: BookingsListResponse | null | undefined): RawBooking[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  const inner = (data as { data?: unknown }).data
  if (Array.isArray(inner)) return inner as RawBooking[]
  if (inner && typeof inner === "object" && Array.isArray((inner as Record<string, unknown>).bookings)) {
    return (inner as { bookings: RawBooking[] }).bookings
  }
  return []
}

export interface SyncOpts {
  full?: boolean
  force?: boolean
}

export interface SyncResult {
  run_id: number
  bookings_seen: number
  bookings_inserted: number
  bookings_updated: number
  errors: Array<{ uid: string; error: string }>
  rate_limited: boolean
}

export async function syncBookings(opts: SyncOpts = {}): Promise<SyncResult> {
  const db = getDb()
  const startedAt = new Date().toISOString()
  const kind = opts.full ? "full" : "incremental"

  const result: Omit<SyncResult, "run_id"> = {
    bookings_seen: 0,
    bookings_inserted: 0,
    bookings_updated: 0,
    errors: [],
    rate_limited: false,
  }

  const runId = Number(
    db
      .prepare("INSERT INTO calcom_sync_runs (started_at, kind) VALUES (?, ?)")
      .run(startedAt, kind).lastInsertRowid,
  )

  try {
    const upsert = prepareUpsert(db)

    let skip = 0
    let pages = 0
    const maxPages = opts.full ? MAX_FULL_PAGES : MAX_FULL_PAGES // incremental still bounded
    while (pages < maxPages) {
      const params = new URLSearchParams()
      params.set("take", String(PAGE_SIZE))
      params.set("skip", String(skip))
      if (!opts.full) {
        const cutoff = new Date(Date.now() - INCREMENTAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
        params.set("afterStart", cutoff.toISOString())
      }

      const r = await apiGet<BookingsListResponse>(`/bookings?${params.toString()}`)
      if (!r.ok) {
        if (r.error.code === "rate_limited") {
          result.rate_limited = true
          incrementUsage(db, "calls_rate_limited", 1)
          break
        }
        incrementUsage(db, "calls_failed", 1)
        result.errors.push({ uid: "(list)", error: r.error.message })
        break
      }
      incrementUsage(db, "calls_succeeded", 1)

      const page = extractBookings(r.data)
      if (page.length === 0) break

      for (const raw of page) {
        const uid = String(raw.uid ?? raw.id ?? "")
        if (!uid) {
          result.errors.push({ uid: "(missing)", error: "booking has no uid/id" })
          continue
        }
        result.bookings_seen += 1
        try {
          const action = upsertBooking(upsert, raw)
          if (action === "inserted") result.bookings_inserted += 1
          else if (action === "updated") result.bookings_updated += 1
        } catch (err) {
          result.errors.push({
            uid,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (page.length < PAGE_SIZE) break
      skip += page.length
      pages += 1
    }

    finishRun(db, runId, result)
    return { run_id: runId, ...result }
  } catch (err) {
    finishRun(db, runId, result, err instanceof Error ? err.message : String(err))
    throw err
  }
}

export function isSyncEnabled(): boolean {
  const row = getDb()
    .prepare("SELECT value FROM calcom_settings WHERE key = 'sync_enabled'")
    .get() as { value: string } | undefined
  return row ? row.value !== "0" : true
}

export function setSyncEnabled(enabled: boolean): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO calcom_settings (key, value, updated_at)
     VALUES ('sync_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(enabled ? "1" : "0")
}

interface UpsertStmts {
  exists: Database.Statement
  insert: Database.Statement
  update: Database.Statement
}

function prepareUpsert(db: Database.Database): UpsertStmts {
  return {
    exists: db.prepare("SELECT uid FROM calcom_bookings WHERE uid = ?"),
    insert: db.prepare(`
      INSERT INTO calcom_bookings (
        uid, title, description, status, event_type_id, event_type_slug,
        start_time, end_time, duration_minutes, attendees_json, meeting_url,
        cancellation_reason, rescheduled, raw, created_at, updated_at, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `),
    update: db.prepare(`
      UPDATE calcom_bookings SET
        title = ?,
        description = ?,
        status = ?,
        event_type_id = ?,
        event_type_slug = ?,
        start_time = ?,
        end_time = ?,
        duration_minutes = ?,
        attendees_json = ?,
        meeting_url = ?,
        cancellation_reason = ?,
        rescheduled = ?,
        raw = ?,
        created_at = ?,
        updated_at = ?,
        synced_at = datetime('now')
      WHERE uid = ?
    `),
  }
}

function upsertBooking(stmts: UpsertStmts, raw: RawBooking): "inserted" | "updated" | "noop" {
  const uid = String(raw.uid ?? raw.id ?? "")
  const title = (raw.title as string | null) ?? null
  const description = (raw.description as string | null) ?? null
  const status = normalizeStatus(raw.status)
  const eventTypeId = parseIntOrNull(raw.eventTypeId ?? (raw.eventType as Record<string, unknown> | undefined)?.id)
  const eventTypeSlug =
    (raw.eventTypeSlug as string | undefined) ??
    ((raw.eventType as Record<string, unknown> | undefined)?.slug as string | undefined) ??
    null
  const startTime = (raw.start as string | undefined) ?? (raw.startTime as string | undefined) ?? null
  const endTime = (raw.end as string | undefined) ?? (raw.endTime as string | undefined) ?? null
  const durationMinutes = computeDurationMinutes(startTime, endTime, raw)
  const attendeesJson = JSON.stringify(Array.isArray(raw.attendees) ? raw.attendees : [])
  const meetingUrl =
    (raw.meetingUrl as string | undefined) ??
    (raw.location as string | undefined) ??
    null
  const cancellationReason = (raw.cancellationReason as string | null) ?? null
  const rescheduled = raw.rescheduled || raw.fromReschedule ? 1 : 0
  const rawJson = JSON.stringify(raw)
  const createdAt = (raw.createdAt as string | undefined) ?? null
  const updatedAt = (raw.updatedAt as string | undefined) ?? null

  const existing = stmts.exists.get(uid) as { uid: string } | undefined
  if (existing) {
    stmts.update.run(
      title,
      description,
      status,
      eventTypeId,
      eventTypeSlug,
      startTime,
      endTime,
      durationMinutes,
      attendeesJson,
      meetingUrl,
      cancellationReason,
      rescheduled,
      rawJson,
      createdAt,
      updatedAt,
      uid,
    )
    return "updated"
  }
  stmts.insert.run(
    uid,
    title,
    description,
    status,
    eventTypeId,
    eventTypeSlug,
    startTime,
    endTime,
    durationMinutes,
    attendeesJson,
    meetingUrl,
    cancellationReason,
    rescheduled,
    rawJson,
    createdAt,
    updatedAt,
  )
  return "inserted"
}

function normalizeStatus(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).toLowerCase()
  // Cal.com surfaces ACCEPTED / PENDING / REJECTED / CANCELLED / AWAITING_HOST.
  // Map to lowercase canonical names; fall through unknowns unchanged.
  if (s === "awaiting_host") return "pending"
  return s
}

function parseIntOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function computeDurationMinutes(
  start: string | null,
  end: string | null,
  raw: RawBooking,
): number | null {
  const explicit = parseIntOrNull(
    raw.duration ?? (raw.eventType as Record<string, unknown> | undefined)?.lengthInMinutes,
  )
  if (explicit != null) return explicit
  if (!start || !end) return null
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.round(ms / 60_000)
}

function finishRun(
  db: Database.Database,
  runId: number,
  result: Omit<SyncResult, "run_id">,
  errorMessage: string | null = null,
): void {
  const errorsPayload = errorMessage
    ? JSON.stringify([{ error: errorMessage }, ...result.errors])
    : result.errors.length > 0
      ? JSON.stringify(result.errors)
      : null
  db.prepare(
    `UPDATE calcom_sync_runs SET
       finished_at = datetime('now'),
       bookings_seen = ?,
       bookings_inserted = ?,
       bookings_updated = ?,
       errors_json = ?
     WHERE id = ?`,
  ).run(
    result.bookings_seen,
    result.bookings_inserted,
    result.bookings_updated,
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
    `INSERT INTO calcom_api_usage (date, ${column}, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       ${column} = ${column} + excluded.${column},
       updated_at = datetime('now')`,
  ).run(today, delta)
}
