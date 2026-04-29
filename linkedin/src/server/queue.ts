import { randomUUID } from "node:crypto"

import type { PostRecord, PublishJobPayload } from "../lib/types"
import { syncPostOutputAndPersist } from "./app-outputs"
import { getDb } from "./db"
import { LinkedInPublisher } from "./publisher"

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

export function enqueuePublish(payload: PublishJobPayload): string {
  const db = getDb()
  const id = randomUUID()

  const isDelayed = payload.scheduled_at && new Date(payload.scheduled_at).getTime() > Date.now()
  const status = isDelayed ? "delayed" : "waiting"
  const runAt = isDelayed
    ? payload.scheduled_at!.replace("T", " ").replace("Z", "")
    : new Date().toISOString().replace("T", " ").replace("Z", "")

  db.prepare(
    "INSERT INTO linkedin_jobs (id, type, payload, status, run_at) VALUES (?, 'publish', ?, ?, ?)",
  ).run(id, JSON.stringify(payload), status, runAt)

  return id
}

export function getQueueStats() {
  const db = getDb()
  const rows = db
    .prepare("SELECT status, COUNT(*) as count FROM linkedin_jobs GROUP BY status")
    .all() as Array<{ status: string; count: number }>

  const stats = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }
  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = row.count
    }
  }
  return stats
}

async function syncPostOutputAfterTransition(
  db: ReturnType<typeof getDb>,
  postId: string,
): Promise<void> {
  const post = db
    .prepare("SELECT * FROM linkedin_posts WHERE id = ?")
    .get(postId) as PostRecord | undefined
  if (!post) return
  await syncPostOutputAndPersist(db, post, null)
}

const POLL_INTERVAL_MS = 3000

export function startWorker() {
  const publisher = new LinkedInPublisher()
  const db = getDb()

  // Crash recovery: reset any active jobs back to waiting
  db.prepare("UPDATE linkedin_jobs SET status = 'waiting', updated_at = datetime('now') WHERE status = 'active'").run()

  const interval = setInterval(() => {
    try {
      // Promote delayed jobs that are due
      db.prepare(
        "UPDATE linkedin_jobs SET status = 'waiting', updated_at = datetime('now') WHERE status = 'delayed' AND run_at <= datetime('now')",
      ).run()

      // Atomically claim one waiting job
      const job = db
        .prepare(
          "UPDATE linkedin_jobs SET status = 'active', attempts = attempts + 1, updated_at = datetime('now') WHERE id = (SELECT id FROM linkedin_jobs WHERE status = 'waiting' AND run_at <= datetime('now') ORDER BY run_at LIMIT 1) RETURNING *",
        )
        .get() as JobRecord | undefined

      if (!job) return

      const payload = JSON.parse(job.payload) as PublishJobPayload

      // Update post status to queued
      db.prepare("UPDATE linkedin_posts SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(payload.post_id)
      void syncPostOutputAfterTransition(db, payload.post_id)

      publisher
        .publish({
          holaboss_user_id: payload.holaboss_user_id,
          content: payload.content,
          scheduled_at: payload.scheduled_at,
        })
        .then((result) => {
          db.prepare(
            "UPDATE linkedin_jobs SET status = 'completed', updated_at = datetime('now') WHERE id = ?",
          ).run(job.id)
          db.prepare(
            "UPDATE linkedin_posts SET status = 'published', external_post_id = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
          ).run(result.external_post_id, payload.post_id)
          void syncPostOutputAfterTransition(db, payload.post_id)
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          if (job.attempts < job.max_attempts) {
            db.prepare(
              "UPDATE linkedin_jobs SET status = 'waiting', error_message = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(message, job.id)
          } else {
            db.prepare(
              "UPDATE linkedin_jobs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(message, job.id)
            db.prepare(
              "UPDATE linkedin_posts SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(message, payload.post_id)
            void syncPostOutputAfterTransition(db, payload.post_id)
          }
          console.error(`[worker] job ${job.id} failed:`, message)
        })
    } catch (err) {
      console.error("[worker] poll error:", err)
    }
  }, POLL_INTERVAL_MS)

  console.log("[worker] started (SQLite job queue)")
  return interval
}
