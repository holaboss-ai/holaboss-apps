import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { z } from "zod"

import type { PostRecord } from "../lib/types"
import { REDDIT_CONFIG } from "../lib/types"
import { syncPostOutputAndPersist } from "./app-outputs"
import { getDb } from "./db"
import {
  resolveHolabossTurnContext,
  updateAppOutput,
} from "./holaboss-bridge"
import { enqueuePublish, getQueueStats } from "./queue"

// Tool descriptions follow ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md
type ErrorCode =
  | "not_found"
  | "invalid_state"
  | "validation_failed"
  | "not_connected"
  | "rate_limited"
  | "upstream_error"
  | "internal"

function text(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] } }
function errCode(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ code, message, ...extra }) }], isError: true as const }
}

async function syncAndPersist(
  db: ReturnType<typeof getDb>,
  post: PostRecord,
  headers: Parameters<typeof resolveHolabossTurnContext>[0],
): Promise<PostRecord> {
  const context = resolveHolabossTurnContext(headers)
  return syncPostOutputAndPersist(db, post, context)
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: `${REDDIT_CONFIG.name} Module`,
    version: "1.0.0",
  })

  server.registerTool(
    "reddit_create_post",
    {
      title: "Create Reddit draft",
      description: `Create a new Reddit text post in 'draft' state. Stored locally — NOT submitted to Reddit.

When to use: the user asks to compose, draft, or write a Reddit post.
When NOT to use: to submit an existing draft (use reddit_publish_post). To edit a draft (use reddit_update_post).
Returns: full PostRecord — { id, title, content, subreddit, status: 'draft', scheduled_at?, created_at, updated_at, output_id? }.
Sibling: pass scheduled_at here (or via reddit_update_post) to defer submission; the actual scheduling is committed when reddit_publish_post is called.`,
      inputSchema: {
        title: z
          .string()
          .max(300)
          .describe("Post title. Hard limit 300 chars (Reddit limit). Subreddit-specific rules may apply (length, capitalization, tags) — surface those errors back to the user."),
        content: z
          .string()
          .max(40000)
          .describe("Post body in Markdown. Hard limit 40,000 chars. Use empty string for a link-only post is NOT supported by this tool — text posts only."),
        subreddit: z
          .string()
          .describe("Target subreddit name WITHOUT the 'r/' prefix, e.g. 'learnprogramming' (not 'r/learnprogramming')."),
        scheduled_at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 with timezone, e.g. '2026-04-26T15:00:00Z'. Stored on the draft only; reddit_publish_post is what actually schedules it.",
          ),
      },
      annotations: {
        title: "Create Reddit draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, content, subreddit, scheduled_at }, extra) => {
      try {
        const db = getDb()
        const id = randomUUID()
        const now = new Date().toISOString()
        db.prepare(
          "INSERT INTO posts (id, title, content, subreddit, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
        ).run(id, title, content, subreddit, scheduled_at ?? null, now, now)

        const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRecord
        const synced = await syncAndPersist(db, post, extra.requestInfo?.headers)
        return text(synced)
      } catch (error) {
        return errCode("internal", error instanceof Error ? error.message : String(error))
      }
    },
  )

  server.registerTool(
    "reddit_update_post",
    {
      title: "Update Reddit draft",
      description: `Edit fields on an existing Reddit post. Only fields you supply change; omitted fields are left as-is.

When to use: revise a draft before submitting, retarget to a different subreddit, or change scheduled_at.
When NOT to use: to edit a post that has already been submitted (this updates only the local record; Reddit is NOT re-edited).
Returns: full updated PostRecord.
Errors: 'Post not found' if post_id doesn't exist.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by reddit_create_post or reddit_list_posts."),
        title: z.string().max(300).optional().describe("New title. Max 300 chars."),
        content: z.string().max(40000).optional().describe("New body in Markdown. Max 40,000 chars."),
        subreddit: z
          .string()
          .optional()
          .describe("New target subreddit WITHOUT 'r/' prefix, e.g. 'learnprogramming'."),
        scheduled_at: z
          .string()
          .optional()
          .describe("New ISO 8601 schedule time with timezone, e.g. '2026-04-26T15:00:00Z'."),
      },
      annotations: {
        title: "Update Reddit draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ post_id, title, content, subreddit, scheduled_at }, extra) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")

      const updates: string[] = ["updated_at = datetime('now')"]
      const params: unknown[] = []
      if (title) { updates.push("title = ?"); params.push(title) }
      if (content) { updates.push("content = ?"); params.push(content) }
      if (subreddit) { updates.push("subreddit = ?"); params.push(subreddit) }
      if (scheduled_at) { updates.push("scheduled_at = ?"); params.push(scheduled_at) }
      params.push(post_id)

      db.prepare(`UPDATE posts SET ${updates.join(", ")} WHERE id = ?`).run(...params)
      const updated = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord
      const synced = await syncAndPersist(db, updated, extra.requestInfo?.headers)
      return text(synced)
    },
  )

  server.registerTool(
    "reddit_list_posts",
    {
      title: "List Reddit posts",
      description: `List local Reddit post records ordered by created_at DESC. (Local Holaboss-managed posts only — does NOT list arbitrary submissions from Reddit.)

When to use: find a specific draft, audit recent activity, filter by subreddit or lifecycle state.
Returns: array of PostRecord. Empty array if none match.`,
      inputSchema: {
        status: z
          .enum(["draft", "queued", "scheduled", "published", "failed"])
          .optional()
          .describe("Filter by lifecycle state. Omit to list all states."),
        subreddit: z
          .string()
          .optional()
          .describe("Filter by exact subreddit name WITHOUT 'r/' prefix, e.g. 'learnprogramming'."),
        limit: z.number().int().positive().max(200).optional().describe("Max results, default 20, max 200."),
      },
      annotations: {
        title: "List Reddit posts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status, subreddit, limit }) => {
      const db = getDb()
      const max = limit ?? 20
      let rows: PostRecord[]
      if (status && subreddit) {
        rows = db.prepare("SELECT * FROM posts WHERE status = ? AND subreddit = ? ORDER BY created_at DESC LIMIT ?").all(status, subreddit, max) as PostRecord[]
      } else if (status) {
        rows = db.prepare("SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, max) as PostRecord[]
      } else if (subreddit) {
        rows = db.prepare("SELECT * FROM posts WHERE subreddit = ? ORDER BY created_at DESC LIMIT ?").all(subreddit, max) as PostRecord[]
      } else {
        rows = db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?").all(max) as PostRecord[]
      }
      return text(rows)
    },
  )

  server.registerTool(
    "reddit_get_post",
    {
      title: "Get Reddit post by id",
      description: `Fetch a single Reddit post record by id.

Prerequisites: post_id from reddit_create_post or reddit_list_posts.
Returns: full PostRecord including title, content, subreddit, status, scheduled_at, published_at, error_message, output_id.
Errors: 'Post not found' if post_id is unknown.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by reddit_create_post or reddit_list_posts."),
      },
      annotations: {
        title: "Get Reddit post by id",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ post_id }) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id)
      if (!post) return errCode("not_found", "Post not found")
      return text(post)
    },
  )

  server.registerTool(
    "reddit_publish_post",
    {
      title: "Publish Reddit post",
      description: `Move a draft into the publish queue. If the draft has a future scheduled_at, the job is held until then; otherwise it fires within seconds.

When to use: the user has approved a draft and wants it submitted to Reddit (now or at the scheduled time).
Prerequisites: a draft created by reddit_create_post.
Side effects: status flips to 'queued'. The actual Reddit API call happens asynchronously — poll reddit_get_publish_status until status is 'published' or 'failed'.
Returns: { job_id, status: 'queued' }.
Errors: 'Post not found'. NOTE: re-calling on an already-queued post creates a duplicate job — call reddit_get_publish_status first if unsure. Subreddit-specific submission rules (karma minimums, account age, flair) surface as a 'failed' status with error_message.`,
      inputSchema: {
        post_id: z.string().describe("Draft post id to publish, returned by reddit_create_post."),
      },
      annotations: {
        title: "Publish Reddit post",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ post_id }, extra) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")

      const userId = process.env.HOLABOSS_USER_ID ?? ""
      const jobId = await enqueuePublish({
        post_id,
        title: post.title,
        content: post.content,
        subreddit: post.subreddit,
        holaboss_user_id: userId,
        scheduled_at: post.scheduled_at,
      })

      db.prepare("UPDATE posts SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(post_id)
      const updated = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord
      await syncAndPersist(db, updated, extra.requestInfo?.headers)
      return text({ job_id: jobId, status: "queued" })
    },
  )

  server.registerTool(
    "reddit_get_publish_status",
    {
      title: "Get publish status",
      description: `Read the current publish status of a Reddit post without mutating it.

When to use: after reddit_publish_post, poll until status is 'published' (success) or 'failed' (error_message will explain — common: subreddit rules, karma minimum, rate limit).
Returns: { status, error_message?, published_at?, updated_at }.
States: 'draft' | 'queued' | 'scheduled' | 'published' | 'failed'.
Errors: 'Post not found'.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by reddit_create_post or reddit_publish_post."),
      },
      annotations: {
        title: "Get publish status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ post_id }) => {
      const db = getDb()
      const post = db
        .prepare("SELECT status, error_message, published_at, updated_at FROM posts WHERE id = ?")
        .get(post_id)
      if (!post) return errCode("not_found", "Post not found")
      return text(post)
    },
  )

  server.registerTool(
    "reddit_cancel_publish",
    {
      title: "Cancel publish",
      description: `Roll a queued or scheduled Reddit post back to 'draft' state. The publish job is dropped (not picked up by the worker). The local record is preserved — the post was never sent to Reddit.

When to use: the user wants to stop a pending submission to edit further or abandon it before it goes live.
Valid states: 'queued' or 'scheduled'. Calling on draft / published / failed returns isError with the offending state.
Returns: { cancelled: true }.
Errors: 'Post not found', or "Cannot cancel post in '<state>' state".`,
      inputSchema: {
        post_id: z.string().describe("Post id (queued or scheduled) to roll back to 'draft'."),
      },
      annotations: {
        title: "Cancel publish",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ post_id }, extra) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")
      if (post.status !== "scheduled" && post.status !== "queued") {
        return errCode("invalid_state", `Cannot cancel post in '${post.status}' state`, { current_status: post.status, allowed_from: ["queued", "scheduled"] })
      }
      db.prepare("UPDATE posts SET status = 'draft', scheduled_at = NULL, updated_at = datetime('now') WHERE id = ?").run(post_id)
      const updated = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord
      await syncAndPersist(db, updated, extra.requestInfo?.headers)
      return text({ cancelled: true })
    },
  )

  server.registerTool(
    "reddit_delete_post",
    {
      title: "Delete Reddit post record",
      description: `Permanently delete a local Reddit post record. Cannot be undone. Does NOT delete a post that has already been submitted to Reddit — only removes our local copy.

When to use: throw away a draft or a failed attempt the user no longer wants in their list.
Valid states: 'draft' or 'failed'. For 'queued' / 'scheduled', call reddit_cancel_publish first to roll back to 'draft'. 'published' cannot be deleted.
Returns: { deleted: true, post_id }.
Errors: 'Post not found', "Cannot delete post in 'queued/scheduled' state. Cancel it first.", "Cannot delete a published post".`,
      inputSchema: {
        post_id: z.string().describe("Draft or failed post id to delete."),
      },
      annotations: {
        title: "Delete Reddit post record",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ post_id }) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")
      if (post.status === "queued" || post.status === "scheduled") return errCode("invalid_state", `Cannot delete post in '${post.status}' state. Cancel it first.`, { current_status: post.status, hint: "call reddit_cancel_publish first" })
      if (post.status === "published") return errCode("invalid_state", "Cannot delete a published post", { current_status: "published" })
      db.prepare("DELETE FROM posts WHERE id = ?").run(post_id)
      if (post.output_id) {
        try {
          await updateAppOutput(post.output_id, { status: "deleted" })
        } catch (syncError) {
          console.error(`[mcp] reddit output mark-deleted failed for post ${post_id}:`, syncError)
        }
      }
      return text({ deleted: true, post_id })
    },
  )

  server.registerTool(
    "reddit_get_queue_stats",
    {
      title: "Queue stats",
      description: `Snapshot of the publish job queue counts.

When to use: diagnostics — confirm work is being processed or piling up.
Returns: { waiting, active, completed, failed, delayed }.`,
      inputSchema: {},
      annotations: {
        title: "Queue stats",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const stats = await getQueueStats()
      return text(stats)
    },
  )

  return server
}

export function startMcpServer(port: number) {
  const transports = new Map<string, SSEServerTransport>()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)

    if (url.pathname === "/mcp/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }

    if (url.pathname === "/mcp/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/mcp/messages", res)
      transports.set(transport.sessionId, transport)
      const mcpServer = createMcpServer()
      await mcpServer.connect(transport)
      return
    }

    if (url.pathname === "/mcp/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId")
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(400)
        res.end("Unknown session")
        return
      }
      await transport.handlePostMessage(req, res)
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  httpServer.listen(port, () => {
    console.log(`[mcp] server listening on port ${port}`)
  })

  return httpServer
}
