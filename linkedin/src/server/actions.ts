import { createServerFn } from "@tanstack/react-start"
import { randomUUID } from "node:crypto"

import type { PostRecord } from "../lib/types"
import { syncPostOutputAndPersist } from "./app-outputs"
import { getDb } from "./db"
import { updateAppOutput } from "./holaboss-bridge"
import { enqueuePublish } from "./queue"

export const fetchPosts = createServerFn({ method: "GET" }).handler(
  async () => {
    const db = getDb()
    return db
      .prepare("SELECT * FROM linkedin_posts ORDER BY created_at DESC LIMIT 50")
      .all() as PostRecord[]
  },
)

export const fetchPost = createServerFn({ method: "GET" })
  .inputValidator((data: { post_id: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    const post = db
      .prepare("SELECT * FROM linkedin_posts WHERE id = ?")
      .get(data.post_id) as PostRecord | undefined
    if (!post) throw new Error("Post not found")
    return post
  })

export const createPost = createServerFn({ method: "POST" })
  .inputValidator((data: { content: string; scheduled_at?: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    const id = randomUUID()
    const now = new Date().toISOString()

    db.prepare(
      "INSERT INTO linkedin_posts (id, content, status, scheduled_at, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)",
    ).run(id, data.content, data.scheduled_at ?? null, now, now)

    const post = db
      .prepare("SELECT * FROM linkedin_posts WHERE id = ?")
      .get(id) as PostRecord
    return syncPostOutputAndPersist(db, post, null)
  })

export const updatePost = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { post_id: string; content: string; scheduled_at?: string | null }) => data,
  )
  .handler(async ({ data }) => {
    const db = getDb()
    db.prepare(
      "UPDATE linkedin_posts SET content = ?, scheduled_at = ?, status = 'draft', error_message = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('draft', 'failed')",
    ).run(data.content, data.scheduled_at ?? null, data.post_id)
    const post = db
      .prepare("SELECT * FROM linkedin_posts WHERE id = ?")
      .get(data.post_id) as PostRecord
    return syncPostOutputAndPersist(db, post, null)
  })

export const publishPost = createServerFn({ method: "POST" })
  .inputValidator((data: { post_id: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    const post = db
      .prepare("SELECT * FROM linkedin_posts WHERE id = ?")
      .get(data.post_id) as PostRecord | undefined

    if (!post) throw new Error("Post not found")

    const userId = process.env.HOLABOSS_USER_ID ?? ""

    const jobId = enqueuePublish({
      post_id: post.id,
      content: post.content,
      holaboss_user_id: userId,
      scheduled_at: post.scheduled_at,
    })

    const isScheduled =
      post.scheduled_at && new Date(post.scheduled_at).getTime() > Date.now()
    const newStatus = isScheduled ? "scheduled" : "queued"

    db.prepare(
      "UPDATE linkedin_posts SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(newStatus, post.id)

    const updated = db
      .prepare("SELECT * FROM linkedin_posts WHERE id = ?")
      .get(post.id) as PostRecord
    await syncPostOutputAndPersist(db, updated, null)

    return { job_id: jobId, status: newStatus }
  })

export const cancelSchedule = createServerFn({ method: "POST" })
  .inputValidator((data: { post_id: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    db.prepare(
      "UPDATE linkedin_jobs SET status = 'failed', error_message = 'Cancelled by user', updated_at = datetime('now') WHERE json_extract(payload, '$.post_id') = ? AND status IN ('waiting', 'delayed')",
    ).run(data.post_id)
    db.prepare(
      "UPDATE linkedin_posts SET status = 'draft', scheduled_at = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(data.post_id)
    const post = db
      .prepare("SELECT * FROM linkedin_posts WHERE id = ?")
      .get(data.post_id) as PostRecord
    return syncPostOutputAndPersist(db, post, null)
  })

export const deletePost = createServerFn({ method: "POST" })
  .inputValidator((data: { post_id: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    const post = db
      .prepare("SELECT output_id FROM linkedin_posts WHERE id = ?")
      .get(data.post_id) as Pick<PostRecord, "output_id"> | undefined
    db.prepare("DELETE FROM linkedin_posts WHERE id = ?").run(data.post_id)
    if (post?.output_id) {
      try {
        await updateAppOutput(post.output_id, { status: "deleted" })
      } catch (syncError) {
        console.error(
          `[actions] linkedin output mark-deleted failed for post ${data.post_id}:`,
          syncError,
        )
      }
    }
    return { deleted: true }
  })
