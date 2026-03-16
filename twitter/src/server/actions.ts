import { createServerFn } from "@tanstack/react-start"
import { randomUUID } from "node:crypto"

import type { PostRecord } from "../lib/types"
import { getDb } from "./db"
import { enqueuePublish } from "./queue"

export const fetchPosts = createServerFn({ method: "GET" }).handler(
  async () => {
    const db = getDb()
    return db
      .prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT 50")
      .all() as PostRecord[]
  },
)

export const fetchPost = createServerFn({ method: "GET" })
  .inputValidator((data: { post_id: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    const post = db
      .prepare("SELECT * FROM posts WHERE id = ?")
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
      "INSERT INTO posts (id, content, status, scheduled_at, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)",
    ).run(id, data.content, data.scheduled_at ?? null, now, now)

    return db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRecord
  })

export const updatePost = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { post_id: string; content: string; scheduled_at?: string | null }) => data,
  )
  .handler(async ({ data }) => {
    const db = getDb()
    db.prepare(
      "UPDATE posts SET content = ?, scheduled_at = ?, status = 'draft', error_message = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('draft', 'failed')",
    ).run(data.content, data.scheduled_at ?? null, data.post_id)
    return db.prepare("SELECT * FROM posts WHERE id = ?").get(data.post_id) as PostRecord
  })

export const publishPost = createServerFn({ method: "POST" })
  .inputValidator((data: { post_id: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    const post = db
      .prepare("SELECT * FROM posts WHERE id = ?")
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
      "UPDATE posts SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(newStatus, post.id)

    return { job_id: jobId, status: newStatus }
  })

export const cancelSchedule = createServerFn({ method: "POST" })
  .inputValidator((data: { post_id: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    db.prepare(
      "UPDATE jobs SET status = 'failed', error_message = 'Cancelled by user', updated_at = datetime('now') WHERE json_extract(payload, '$.post_id') = ? AND status IN ('waiting', 'delayed')",
    ).run(data.post_id)
    db.prepare(
      "UPDATE posts SET status = 'draft', scheduled_at = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(data.post_id)
    return db.prepare("SELECT * FROM posts WHERE id = ?").get(data.post_id) as PostRecord
  })

export const deletePost = createServerFn({ method: "POST" })
  .inputValidator((data: { post_id: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    db.prepare("DELETE FROM posts WHERE id = ?").run(data.post_id)
    return { deleted: true }
  })
