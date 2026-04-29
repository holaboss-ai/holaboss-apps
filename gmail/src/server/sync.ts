import type Database from "better-sqlite3"

import { getDb } from "./db"
import {
  GMAIL_API_BASE,
  gmailProxy,
  type ThreadListResponse,
  type ThreadMetadataResponse,
} from "./google-api"

// Gmail thread mirror — last 30 days' threads with subject + last
// sender + snippet, refreshed every 15 minutes.
//
// Strategy:
//   1. List threads via /threads?q=newer_than:30d&maxResults=100
//      (paginate with pageToken). Each entry has { id, historyId }.
//   2. For each thread, if NOT in our table OR historyId differs,
//      fetch /threads/{id}?format=metadata to read subject + last
//      message headers. Cap fetches per run to bound API quota.
//   3. Existing rows whose historyId matches are touched-by-time only
//      (synced_at refreshed) so the agent knows the thread still exists.

const LIST_PAGE_LIMIT = 100
const MAX_LIST_PAGES = 20 // 2000 thread ids per run
const MAX_METADATA_FETCHES = 200 // per-run cap on detail calls
const QUERY_DEFAULT = "newer_than:30d"

interface ThreadRow {
  thread_id: string
  history_id: string | null
}

export interface SyncOpts {
  full?: boolean
  query?: string
}

export interface SyncResult {
  run_id: number
  threads_seen: number
  threads_inserted: number
  threads_updated: number
  threads_fetched: number
  errors: Array<{ thread_id: string; error: string }>
  rate_limited: boolean
}

export async function syncThreads(opts: SyncOpts = {}): Promise<SyncResult> {
  const db = getDb()
  const startedAt = new Date().toISOString()
  const kind = opts.full ? "full" : "incremental"
  const result: Omit<SyncResult, "run_id"> = {
    threads_seen: 0,
    threads_inserted: 0,
    threads_updated: 0,
    threads_fetched: 0,
    errors: [],
    rate_limited: false,
  }

  const runId = Number(
    db
      .prepare("INSERT INTO gmail_sync_runs (started_at, kind) VALUES (?, ?)")
      .run(startedAt, kind).lastInsertRowid,
  )

  try {
    const query = opts.query ?? QUERY_DEFAULT
    const existingByThread = readExistingThreadVersions(db)
    const upsert = prepareUpsertStatements(db)
    let pageToken: string | undefined

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params = new URLSearchParams()
      params.set("q", query)
      params.set("maxResults", String(LIST_PAGE_LIMIT))
      if (pageToken) params.set("pageToken", pageToken)
      const url = `${GMAIL_API_BASE}/threads?${params.toString()}`

      const r = await gmailProxy<ThreadListResponse>(url)
      if (r.status === 429) {
        result.rate_limited = true
        incrementUsage(db, "calls_rate_limited", 1)
        break
      }
      if (r.status >= 400 || !r.data) {
        incrementUsage(db, "calls_failed", 1)
        result.errors.push({
          thread_id: "(list)",
          error: `gmail list status ${r.status}`,
        })
        break
      }
      incrementUsage(db, "calls_succeeded", 1)

      const threads = r.data.threads ?? []
      if (threads.length === 0) break

      for (const t of threads) {
        if (!t.id) continue
        result.threads_seen += 1
        const cached = existingByThread.get(t.id)
        const needsFetch =
          opts.full ||
          !cached ||
          (t.historyId && cached.history_id !== t.historyId)

        if (!needsFetch) {
          db.prepare(
            "UPDATE gmail_threads SET synced_at = datetime('now') WHERE thread_id = ?",
          ).run(t.id)
          continue
        }

        if (result.threads_fetched >= MAX_METADATA_FETCHES) {
          // Defer remaining detail fetches to the next tick — listing
          // already gave us thread ids; we just won't re-hydrate their
          // metadata this run.
          continue
        }

        const detail = await fetchThreadMetadata(db, t.id, result)
        if (detail.kind === "rate_limited") {
          result.rate_limited = true
          break
        }
        if (detail.kind === "ok") {
          const action = upsertThread(upsert, t.id, t.historyId ?? null, detail.metadata)
          if (action === "inserted") result.threads_inserted += 1
          else result.threads_updated += 1
        }
      }

      if (result.rate_limited) break
      pageToken = r.data.nextPageToken
      if (!pageToken) break
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
    .prepare("SELECT value FROM gmail_settings WHERE key = 'sync_enabled'")
    .get() as { value: string } | undefined
  return row ? row.value !== "0" : true
}

export function setSyncEnabled(enabled: boolean): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO gmail_settings (key, value, updated_at)
     VALUES ('sync_enabled', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(enabled ? "1" : "0")
}

async function fetchThreadMetadata(
  db: Database.Database,
  threadId: string,
  result: { threads_fetched: number; errors: Array<{ thread_id: string; error: string }> },
): Promise<
  | { kind: "ok"; metadata: ThreadMetadataResponse }
  | { kind: "error" }
  | { kind: "rate_limited" }
> {
  const url = `${GMAIL_API_BASE}/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
  const r = await gmailProxy<ThreadMetadataResponse>(url)
  if (r.status === 429) {
    incrementUsage(db, "calls_rate_limited", 1)
    return { kind: "rate_limited" }
  }
  if (r.status >= 400 || !r.data) {
    incrementUsage(db, "calls_failed", 1)
    result.errors.push({ thread_id: threadId, error: `metadata status ${r.status}` })
    return { kind: "error" }
  }
  incrementUsage(db, "calls_succeeded", 1)
  result.threads_fetched += 1
  return { kind: "ok", metadata: r.data }
}

interface UpsertStmts {
  exists: Database.Statement
  insert: Database.Statement
  update: Database.Statement
}

function prepareUpsertStatements(db: Database.Database): UpsertStmts {
  return {
    exists: db.prepare("SELECT thread_id FROM gmail_threads WHERE thread_id = ?"),
    insert: db.prepare(`
      INSERT INTO gmail_threads (
        thread_id, history_id, subject, last_from, last_to, last_snippet,
        message_count, last_message_at, label_ids, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `),
    update: db.prepare(`
      UPDATE gmail_threads SET
        history_id = ?,
        subject = ?,
        last_from = ?,
        last_to = ?,
        last_snippet = ?,
        message_count = ?,
        last_message_at = ?,
        label_ids = ?,
        synced_at = datetime('now')
      WHERE thread_id = ?
    `),
  }
}

function upsertThread(
  stmts: UpsertStmts,
  threadId: string,
  historyId: string | null,
  metadata: ThreadMetadataResponse,
): "inserted" | "updated" {
  const messages = metadata.messages ?? []
  const last = messages[messages.length - 1]
  const headerOf = (name: string): string | null => {
    if (!last?.payload?.headers) return null
    const h = last.payload.headers.find((x) => x.name.toLowerCase() === name.toLowerCase())
    return h?.value ?? null
  }
  const subject = headerOf("Subject")
  const lastFrom = headerOf("From")
  const lastTo = headerOf("To")
  const lastSnippet = last?.snippet ?? null
  const messageCount = messages.length
  const internalMs = last?.internalDate ? Number(last.internalDate) : null
  const lastMessageAt = internalMs && Number.isFinite(internalMs)
    ? new Date(internalMs).toISOString()
    : null
  const labelIds = JSON.stringify(last?.labelIds ?? [])

  const exists = stmts.exists.get(threadId) as { thread_id: string } | undefined
  if (exists) {
    stmts.update.run(
      historyId,
      subject,
      lastFrom,
      lastTo,
      lastSnippet,
      messageCount,
      lastMessageAt,
      labelIds,
      threadId,
    )
    return "updated"
  }
  stmts.insert.run(
    threadId,
    historyId,
    subject,
    lastFrom,
    lastTo,
    lastSnippet,
    messageCount,
    lastMessageAt,
    labelIds,
  )
  return "inserted"
}

function readExistingThreadVersions(db: Database.Database): Map<string, ThreadRow> {
  const rows = db
    .prepare("SELECT thread_id, history_id FROM gmail_threads")
    .all() as ThreadRow[]
  const map = new Map<string, ThreadRow>()
  for (const r of rows) map.set(r.thread_id, r)
  return map
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
    `UPDATE gmail_sync_runs SET
       finished_at = datetime('now'),
       threads_seen = ?,
       threads_inserted = ?,
       threads_updated = ?,
       threads_fetched = ?,
       errors_json = ?
     WHERE id = ?`,
  ).run(
    result.threads_seen,
    result.threads_inserted,
    result.threads_updated,
    result.threads_fetched,
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
    `INSERT INTO gmail_api_usage (date, ${column}, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       ${column} = ${column} + excluded.${column},
       updated_at = datetime('now')`,
  ).run(today, delta)
}
