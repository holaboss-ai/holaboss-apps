import { randomUUID } from "node:crypto"

import type { SendJobPayload } from "../lib/types"
import { getDb } from "./db"
import { sendEmail } from "./google-api"
import { syncDraftOutput } from "./app-outputs"

interface JobRecord {
  id: string
  type: string
  payload: string
  status: string
  run_at: string
  attempts: number
  max_attempts: number
  error_message: string | null
  created_at: string
  updated_at: string
}

export function enqueueSend(payload: SendJobPayload): string {
  const db = getDb()
  const id = randomUUID()
  db.prepare(
    "INSERT INTO gmail_jobs (id, type, payload, status, run_at) VALUES (?, 'send', ?, 'waiting', datetime('now'))",
  ).run(id, JSON.stringify(payload))
  return id
}

export function getQueueStats() {
  const db = getDb()
  const rows = db
    .prepare("SELECT status, COUNT(*) as count FROM gmail_jobs GROUP BY status")
    .all() as Array<{ status: string; count: number }>

  const stats = { waiting: 0, active: 0, completed: 0, failed: 0 }
  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = row.count
    }
  }
  return stats
}

const POLL_INTERVAL_MS = 3000

export function startWorker() {
  const db = getDb()

  // Crash recovery: reset any active jobs back to waiting
  db.prepare("UPDATE gmail_jobs SET status = 'waiting', updated_at = datetime('now') WHERE status = 'active'").run()

  const interval = setInterval(() => {
    try {
      // Atomically claim one waiting job
      const job = db
        .prepare(
          "UPDATE gmail_jobs SET status = 'active', attempts = attempts + 1, updated_at = datetime('now') WHERE id = (SELECT id FROM gmail_jobs WHERE status = 'waiting' AND run_at <= datetime('now') ORDER BY run_at LIMIT 1) RETURNING *",
        )
        .get() as JobRecord | undefined

      if (!job) return

      const payload = JSON.parse(job.payload) as SendJobPayload

      // Mark draft as queued
      db.prepare("UPDATE gmail_drafts SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(payload.draft_id)

      sendEmail({
        to: payload.to_email,
        subject: payload.subject,
        body: payload.body,
        threadId: payload.thread_id,
      })
        .then(() => {
          db.prepare(
            "UPDATE gmail_jobs SET status = 'completed', updated_at = datetime('now') WHERE id = ?",
          ).run(job.id)
          db.prepare(
            "UPDATE gmail_drafts SET status = 'sent', sent_at = datetime('now'), error_message = NULL, updated_at = datetime('now') WHERE id = ?",
          ).run(payload.draft_id)

          // Sync output status (best-effort)
          const draft = db.prepare("SELECT * FROM gmail_drafts WHERE id = ?").get(payload.draft_id) as import("../lib/types").DraftRecord | undefined
          if (draft) {
            syncDraftOutput(draft).catch((err) => {
              console.warn("[gmail] failed to sync draft output after send", err)
            })
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          if (job.attempts < job.max_attempts) {
            db.prepare(
              "UPDATE gmail_jobs SET status = 'waiting', error_message = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(message, job.id)
            // Revert draft to pending so user sees it's not stuck
            db.prepare(
              "UPDATE gmail_drafts SET status = 'pending', error_message = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(message, payload.draft_id)
          } else {
            db.prepare(
              "UPDATE gmail_jobs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(message, job.id)
            db.prepare(
              "UPDATE gmail_drafts SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(message, payload.draft_id)
          }
          console.error(`[gmail-worker] job ${job.id} failed:`, message)
        })
    } catch (err) {
      console.error("[gmail-worker] poll error:", err)
    }
  }, POLL_INTERVAL_MS)

  console.log("[gmail-worker] started (SQLite job queue)")
  return interval
}
