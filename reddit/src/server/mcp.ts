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
import {
  isMetricsRefreshEnabled,
  refreshPostMetrics,
  setMetricsRefreshEnabled,
} from "./metrics"
import { enqueuePublish, getQueueStats } from "./queue"
import { listTrackedPosts, setPostViews, trackPost } from "./tracking"

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
function success<T extends Record<string, unknown>>(data: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data }
}
function errCode(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ code, message, ...extra }) }], isError: true as const }
}

const PostStatusEnum = z.enum(["draft", "queued", "scheduled", "published", "failed"])
const PostRecordShape = {
  id: z.string(),
  title: z.string(),
  content: z.string(),
  subreddit: z.string(),
  status: PostStatusEnum,
  scheduled_at: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  external_post_id: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  output_id: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}
const PublishStatusShape = {
  status: PostStatusEnum,
  error_message: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  updated_at: z.string(),
}
const PublishResultShape = { job_id: z.string(), status: z.literal("queued") }
const CancelResultShape = { cancelled: z.literal(true) }
const DeleteResultShape = { deleted: z.literal(true), post_id: z.string() }
const QueueStatsShape = {
  waiting: z.number(),
  active: z.number(),
  completed: z.number(),
  failed: z.number(),
  delayed: z.number(),
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
Sibling: pass scheduled_at here (or via reddit_update_post) to defer submission; the actual scheduling is committed when reddit_publish_post is called.
Errors: { code: 'internal' } on unexpected exception.`,
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
      outputSchema: PostRecordShape,
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
          "INSERT INTO reddit_posts (id, title, content, subreddit, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
        ).run(id, title, content, subreddit, scheduled_at ?? null, now, now)

        const post = db.prepare("SELECT * FROM reddit_posts WHERE id = ?").get(id) as PostRecord
        const synced = await syncAndPersist(db, post, extra.requestInfo?.headers)
        return success(synced as unknown as Record<string, unknown>)
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
Errors: { code: 'not_found' } if post_id is unknown.`,
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
      outputSchema: PostRecordShape,
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
      const post = db.prepare("SELECT * FROM reddit_posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")

      const updates: string[] = ["updated_at = datetime('now')"]
      const params: unknown[] = []
      if (title) { updates.push("title = ?"); params.push(title) }
      if (content) { updates.push("content = ?"); params.push(content) }
      if (subreddit) { updates.push("subreddit = ?"); params.push(subreddit) }
      if (scheduled_at) { updates.push("scheduled_at = ?"); params.push(scheduled_at) }
      params.push(post_id)

      db.prepare(`UPDATE reddit_posts SET ${updates.join(", ")} WHERE id = ?`).run(...params)
      const updated = db.prepare("SELECT * FROM reddit_posts WHERE id = ?").get(post_id) as PostRecord
      const synced = await syncAndPersist(db, updated, extra.requestInfo?.headers)
      return success(synced as unknown as Record<string, unknown>)
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
        status: PostStatusEnum.optional().describe("Filter by lifecycle state. Omit to list all states."),
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
        rows = db.prepare("SELECT * FROM reddit_posts WHERE status = ? AND subreddit = ? ORDER BY created_at DESC LIMIT ?").all(status, subreddit, max) as PostRecord[]
      } else if (status) {
        rows = db.prepare("SELECT * FROM reddit_posts WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, max) as PostRecord[]
      } else if (subreddit) {
        rows = db.prepare("SELECT * FROM reddit_posts WHERE subreddit = ? ORDER BY created_at DESC LIMIT ?").all(subreddit, max) as PostRecord[]
      } else {
        rows = db.prepare("SELECT * FROM reddit_posts ORDER BY created_at DESC LIMIT ?").all(max) as PostRecord[]
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
Errors: { code: 'not_found' } if post_id is unknown.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by reddit_create_post or reddit_list_posts."),
      },
      outputSchema: PostRecordShape,
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
      const post = db.prepare("SELECT * FROM reddit_posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")
      return success(post as unknown as Record<string, unknown>)
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
Errors: { code: 'not_found' } if post_id is unknown. Subreddit-specific submission rules (karma minimums, account age, flair) surface as a 'failed' status with error_message via reddit_get_publish_status. NOTE: re-calling on an already-queued post creates a duplicate job — call reddit_get_publish_status first if unsure.`,
      inputSchema: {
        post_id: z.string().describe("Draft post id to publish, returned by reddit_create_post."),
      },
      outputSchema: PublishResultShape,
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
      const post = db.prepare("SELECT * FROM reddit_posts WHERE id = ?").get(post_id) as PostRecord | undefined
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

      db.prepare("UPDATE reddit_posts SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(post_id)
      const updated = db.prepare("SELECT * FROM reddit_posts WHERE id = ?").get(post_id) as PostRecord
      await syncAndPersist(db, updated, extra.requestInfo?.headers)
      return success({ job_id: jobId, status: "queued" as const })
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
Errors: { code: 'not_found' } if post_id is unknown.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by reddit_create_post or reddit_publish_post."),
      },
      outputSchema: PublishStatusShape,
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
        .prepare("SELECT status, error_message, published_at, updated_at FROM reddit_posts WHERE id = ?")
        .get(post_id) as Record<string, unknown> | undefined
      if (!post) return errCode("not_found", "Post not found")
      return success(post)
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
Errors: { code: 'not_found' } if post_id is unknown; { code: 'invalid_state', current_status, allowed_from } if status is not 'queued'/'scheduled'.`,
      inputSchema: {
        post_id: z.string().describe("Post id (queued or scheduled) to roll back to 'draft'."),
      },
      outputSchema: CancelResultShape,
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
      const post = db.prepare("SELECT * FROM reddit_posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")
      if (post.status !== "scheduled" && post.status !== "queued") {
        return errCode("invalid_state", `Cannot cancel post in '${post.status}' state`, { current_status: post.status, allowed_from: ["queued", "scheduled"] })
      }
      db.prepare("UPDATE reddit_posts SET status = 'draft', scheduled_at = NULL, updated_at = datetime('now') WHERE id = ?").run(post_id)
      const updated = db.prepare("SELECT * FROM reddit_posts WHERE id = ?").get(post_id) as PostRecord
      await syncAndPersist(db, updated, extra.requestInfo?.headers)
      return success({ cancelled: true as const })
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
Errors: { code: 'not_found' } if post_id is unknown; { code: 'invalid_state', current_status, hint? } if status is 'queued' / 'scheduled' / 'published'.`,
      inputSchema: {
        post_id: z.string().describe("Draft or failed post id to delete."),
      },
      outputSchema: DeleteResultShape,
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
      const post = db.prepare("SELECT * FROM reddit_posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")
      if (post.status === "queued" || post.status === "scheduled") return errCode("invalid_state", `Cannot delete post in '${post.status}' state. Cancel it first.`, { current_status: post.status, hint: "call reddit_cancel_publish first" })
      if (post.status === "published") return errCode("invalid_state", "Cannot delete a published post", { current_status: "published" })
      db.prepare("DELETE FROM reddit_posts WHERE id = ?").run(post_id)
      if (post.output_id) {
        try {
          await updateAppOutput(post.output_id, { status: "deleted" })
        } catch (syncError) {
          console.error(`[mcp] reddit output mark-deleted failed for post ${post_id}:`, syncError)
        }
      }
      return success({ deleted: true as const, post_id })
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
      outputSchema: QueueStatsShape,
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
      return success(stats as unknown as Record<string, unknown>)
    },
  )

  // ─── Reddit post monitoring ──────────────────────────────────────
  // Lifecycle: track_post (register URL) → scheduler refreshes every
  // 4h (12 captures over 48h) → 48h freeze with final values + manual
  // views.

  const TrackPostResultShape = {
    post_id: z.string(),
    external_post_id: z.string(),
    subreddit: z.string(),
    title: z.string(),
    source_url: z.string(),
    published_at: z.string().nullable(),
    monitoring_started_at: z.string(),
    already_tracked: z.boolean(),
  }

  server.registerTool(
    "reddit_track_post",
    {
      title: "Register a Reddit post URL for 48-hour monitoring",
      description: `Register an externally-published Reddit post for fixed-window monitoring. Once registered, the in-process scheduler captures upvotes / comments / upvote_ratio every 4 hours for 48 hours (12 snapshots). After 48h the final values are frozen on the post record and the dashboard prompts the user to manually fill in the Views count.

When to use: a user pastes a Reddit post URL and asks to "track this", "monitor this", "watch this for the first 48 hours", or you're processing a batch of links the user dropped into chat. Re-registering an already-tracked URL is idempotent — the original tracking continues, and the response indicates already_tracked=true.
When NOT to use: for posts the app drafted itself (use the publish flow + the Twitter-style metrics path instead). For posts you only need a single one-off score for (just call the Reddit API directly via the agent's general HTTP tooling — no need to take up a tracking slot).
Returns: { post_id, external_post_id, subreddit, title, source_url, published_at, monitoring_started_at, already_tracked }. post_id is the local id you'll pass to other tools (refresh, set_views, etc.).
Prerequisites: a connected Reddit account.
Errors: { code: 'validation_failed' } when URL doesn't parse or subreddit can't be inferred. { code: 'not_found' } when the post id resolves to nothing on Reddit. { code: 'not_connected' } on 401/403. { code: 'rate_limited' } on 429. { code: 'upstream_error' } on 5xx.`,
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe(
            "Reddit post URL. Accepts reddit.com/r/<sub>/comments/<id>/..., redd.it/<id>, t3_<id>, or a bare base36 id.",
          ),
        subreddit: z
          .string()
          .optional()
          .describe(
            "Subreddit name (without r/ prefix). Required only for short links / bare ids that don't carry the subreddit; otherwise inferred.",
          ),
      },
      outputSchema: TrackPostResultShape,
      annotations: {
        title: "Register a Reddit post URL for 48-hour monitoring",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, subreddit }) => {
      const result = await trackPost({ url, subreddit: subreddit ?? null })
      if (!result.ok) {
        return errCode(result.error.code, result.error.message)
      }
      return success(result.data as unknown as Record<string, unknown>)
    },
  )

  const TrackedPostListItemShape = z.object({
    post_id: z.string(),
    external_post_id: z.string().nullable(),
    subreddit: z.string(),
    title: z.string(),
    source_url: z.string().nullable(),
    published_at: z.string().nullable(),
    monitoring_started_at: z.string().nullable(),
    monitoring_completed_at: z.string().nullable(),
    deleted_at: z.string().nullable(),
    deleted_reason: z.string().nullable(),
    views: z.number().nullable(),
    final_score: z.number().nullable(),
    final_num_comments: z.number().nullable(),
    final_upvote_ratio: z.number().nullable(),
  })

  server.registerTool(
    "reddit_list_tracked_posts",
    {
      title: "List Reddit posts under monitoring",
      description: `Return every post that has been registered for tracking, with its current monitoring status, removal info if any, and final values once the 48h window has closed. Use this to compose summary tables, find posts that still need a Views count entered, or audit which posts are mid-monitoring.

When to use: composing the internal / external monitoring dashboards, answering "what posts are we tracking right now?", or finding the post_id to pass into reddit_set_post_views.
When NOT to use: when you only need the freshly-pulled metric values for a known post — query the SQL directly off reddit_post_metrics, that's denser.
Returns: { items: TrackedPostListItem[] }.`,
      inputSchema: {},
      outputSchema: { items: z.array(TrackedPostListItemShape) },
      annotations: {
        title: "List Reddit posts under monitoring",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const items = listTrackedPosts()
      return success({ items } as unknown as Record<string, unknown>)
    },
  )

  const SetPostViewsResultShape = {
    post_id: z.string(),
    views: z.number(),
    monitoring_completed_at: z.string().nullable(),
  }

  server.registerTool(
    "reddit_set_post_views",
    {
      title: "Set the manually-entered Views count for a tracked Reddit post",
      description: `Reddit's public API doesn't reliably expose post view counts to the post owner — the value is provided manually after the 48h monitoring window closes. This tool persists that number on the post row so the external summary dashboard can show it alongside the captured upvotes / comments.

When to use: a user supplies the Views number for a tracked post (typically while filling in an output report), or the user wants to update an existing entry.
When NOT to use: as a substitute for the automated metrics capture (the scheduler handles upvotes / comments). Before the monitoring window has elapsed (still allowed, but the value reads as a moving target — usually you want the final count).
Returns: { post_id, views, monitoring_completed_at }.
Errors: { code: 'not_found' } when post_id doesn't exist. { code: 'validation_failed' } when views is negative or non-numeric.`,
      inputSchema: {
        post_id: z.string().describe("Local post id (from reddit_track_post or reddit_list_tracked_posts)."),
        views: z.number().int().nonnegative().describe("Manually-entered Views count."),
      },
      outputSchema: SetPostViewsResultShape,
      annotations: {
        title: "Set the manually-entered Views count for a tracked Reddit post",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ post_id, views }) => {
      try {
        const updated = setPostViews({ post_id, views })
        if (!updated) {
          return errCode("not_found", `No tracked post with id "${post_id}"`)
        }
        return success(updated as unknown as Record<string, unknown>)
      } catch (err) {
        return errCode(
          "validation_failed",
          err instanceof Error ? err.message : "set_views_failed",
        )
      }
    },
  )

  const RefreshResultShape = {
    run_id: z.number(),
    posts_considered: z.number(),
    posts_refreshed: z.number(),
    posts_skipped: z.number(),
    posts_deleted: z.number(),
    posts_completed: z.number(),
    rate_limited: z.boolean(),
    errors: z.array(z.object({ post_id: z.string(), error: z.string() })),
  }

  server.registerTool(
    "reddit_refresh_post_metrics",
    {
      title: "Refresh Reddit metrics for tracked posts",
      description: `Capture a fresh snapshot for any tracked Reddit post that has crossed its next 4h milestone. The in-process scheduler already calls this every 5 minutes and skips posts not yet due — most agent-driven calls will just want force=true on a specific post.

When to use: user asks to "refresh now" for a specific post, or you want to seed the very first snapshot immediately after track_post (the scheduler's next 5-min tick may be 4 minutes away).
When NOT to use: as a way to skip the milestone schedule on the routine path (the per-post cap is still 12 snapshots over 48h regardless).
Returns: { run_id, posts_considered, posts_refreshed, posts_skipped, posts_deleted, posts_completed, rate_limited, errors[] }.
Errors: structured-result-only for per-post failures; rate_limited=true reflects 429.`,
      inputSchema: {
        post_ids: z
          .array(z.string())
          .optional()
          .describe("Restrict to specific local post ids."),
        force: z
          .boolean()
          .optional()
          .describe("Bypass the milestone check and capture now."),
      },
      outputSchema: RefreshResultShape,
      annotations: {
        title: "Refresh Reddit metrics for tracked posts",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ post_ids, force }) => {
      try {
        const result = await refreshPostMetrics({
          post_ids,
          force: Boolean(force),
        })
        return success(result as unknown as Record<string, unknown>)
      } catch (err) {
        return errCode(
          "internal",
          err instanceof Error ? err.message : "metrics_refresh_failed",
        )
      }
    },
  )

  const SetRefreshResultShape = { enabled: z.boolean() }

  server.registerTool(
    "reddit_set_metrics_refresh",
    {
      title: "Pause or resume the Reddit metrics scheduler",
      description: `Flip the metrics_refresh_enabled flag stored in reddit_settings. When disabled, the in-process scheduler skips refresh ticks; tracked posts continue accumulating untouched until re-enabled.

When to use: the user asks to pause / resume monitoring globally, e.g. during a sensitive period, while debugging quota issues, or after a known Composio outage.
When NOT to use: to mute a single post (no per-post mute exists yet — the deletion path covers genuinely-removed posts already).
Returns: { enabled }.`,
      inputSchema: {
        enabled: z.boolean(),
      },
      outputSchema: SetRefreshResultShape,
      annotations: {
        title: "Pause or resume the Reddit metrics scheduler",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ enabled }) => {
      try {
        setMetricsRefreshEnabled(Boolean(enabled))
        return success({ enabled: isMetricsRefreshEnabled() })
      } catch (err) {
        return errCode(
          "internal",
          err instanceof Error ? err.message : "metrics_setting_failed",
        )
      }
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
