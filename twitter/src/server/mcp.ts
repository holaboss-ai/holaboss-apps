import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { z } from "zod"

import type { PostRecord } from "../lib/types"
import { TWITTER_CONFIG } from "../lib/types"
import { syncPostOutputAndPersist } from "./app-outputs"
import { getDb } from "./db"
import {
  resolveHolabossTurnContext,
  updateAppOutput,
} from "./holaboss-bridge"
import {
  listDirectMessages,
  listRecentDmEvents,
  lookupUserByHandle,
  sendDirectMessage,
} from "./dm"
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
function success<T extends Record<string, unknown>>(data: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data }
}
function errCode(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ code, message, ...extra }) }], isError: true as const }
}

// Output shapes — mirror PostRecord plus action-result envelopes.
const PostStatusEnum = z.enum(["draft", "queued", "scheduled", "published", "failed"])
const PostRecordShape = {
  id: z.string(),
  content: z.string(),
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

const SendDmResultShape = {
  dm_event_id: z.string(),
  dm_conversation_id: z.string(),
}

const DmEventShape = z.object({
  dm_event_id: z.string(),
  dm_conversation_id: z.string(),
  event_type: z.string().describe("'MessageCreate' for actual messages; other values like 'ParticipantsJoin' are non-message events the agent should usually skip."),
  text: z.string().optional(),
  sender_id: z.string().optional().describe("Numeric X user id of the sender. Compare to the participant_id passed in to tell 'me' from 'them'."),
  created_at: z.string().optional(),
})

const ListDmsResultShape = {
  messages: z.array(DmEventShape),
  result_count: z.number(),
  next_pagination_token: z
    .string()
    .optional()
    .describe("Pass back as `pagination_token` on the next call to fetch the next page. Absent on last page."),
}

const DmEventEnrichedShape = z.object({
  dm_event_id: z.string(),
  dm_conversation_id: z.string(),
  event_type: z.string(),
  text: z.string().optional(),
  sender_id: z.string().optional(),
  sender_handle: z.string().optional().describe("X handle without '@', e.g. 'joshua'. Inlined from X's users include — no follow-up lookup needed."),
  sender_name: z.string().optional().describe("Display name, e.g. 'Joshua A'."),
  created_at: z.string().optional(),
})

const SenderSummaryShape = z.object({
  user_id: z.string().describe("Numeric X user id. Pass to twitter_send_dm / twitter_list_dms as `participant_id`."),
  handle: z.string().optional().describe("X handle without '@'."),
  name: z.string().optional().describe("Display name."),
  event_count: z.number().describe("Number of events in this page from this sender (any event_type)."),
  last_event_at: z.string().optional(),
  last_message_text: z.string().optional().describe("Truncated preview (≤140 chars) of the sender's most recent MessageCreate. Absent for senders whose only events were joins/leaves."),
  last_dm_conversation_id: z.string().optional(),
})

const ListRecentDmEventsResultShape = {
  messages: z.array(DmEventEnrichedShape),
  senders: z.array(SenderSummaryShape).describe("Per-sender rollup of `messages` (deduped by user_id, sorted newest-first). Use this directly to answer 'who has DM'd me' without scanning `messages`."),
  result_count: z.number(),
  next_pagination_token: z.string().optional(),
}

const LookupUserResultShape = {
  user_id: z.string().describe("Numeric X user id. Pass this as `participant_id` to twitter_send_dm / twitter_list_dms."),
  username: z.string().describe("Canonical handle without '@'."),
  name: z.string().optional().describe("Display name, e.g. 'Joshua A'. Absent on rare accounts."),
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
    name: `${TWITTER_CONFIG.name} Module`,
    version: "1.0.0",
  })

  server.registerTool(
    "twitter_create_post",
    {
      title: "Create tweet draft",
      description: `Create a new tweet in 'draft' state. Stored locally — NOT published to X.

When to use: the user asks to compose, draft, or write a tweet.
When NOT to use: to publish an existing draft (use twitter_publish_post). To edit a draft (use twitter_update_post).
Returns: full PostRecord — { id, content, status: 'draft', scheduled_at?, created_at, updated_at, output_id? }.
Sibling: pass scheduled_at here (or via twitter_update_post) to defer publishing; the actual scheduling is committed when twitter_publish_post is called.
Errors: { code: 'internal' } on unexpected exception.`,
      inputSchema: {
        content: z.string().max(280).describe("Tweet body. Hard limit 280 chars (X limit) — exceed it and the call returns isError."),
        scheduled_at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 with timezone, e.g. '2026-04-26T15:00:00Z'. Stored on the draft only; twitter_publish_post is what actually schedules it.",
          ),
      },
      outputSchema: PostRecordShape,
      annotations: {
        title: "Create tweet draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ content, scheduled_at }, extra) => {
      try {
        const db = getDb()
        const id = randomUUID()
        const now = new Date().toISOString()
        db.prepare(
          "INSERT INTO twitter_posts (id, content, status, scheduled_at, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)",
        ).run(id, content, scheduled_at ?? null, now, now)

        const post = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(id) as PostRecord
        const synced = await syncAndPersist(db, post, extra.requestInfo?.headers)
        return success(synced as unknown as Record<string, unknown>)
      } catch (error) {
        return errCode("internal", error instanceof Error ? error.message : String(error))
      }
    },
  )

  server.registerTool(
    "twitter_update_post",
    {
      title: "Update tweet draft",
      description: `Edit fields on an existing tweet. Only fields you supply change; omitted fields are left as-is.

When to use: revise a draft before publishing, or change the scheduled_at on a draft.
When NOT to use: to edit a tweet that has already been published (this updates only the local record; X is NOT re-edited).
Returns: full updated PostRecord.
Errors: { code: 'not_found' } if post_id is unknown.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by twitter_create_post or twitter_list_posts."),
        content: z.string().max(280).optional().describe("New tweet body. Max 280 chars."),
        scheduled_at: z
          .string()
          .optional()
          .describe("New ISO 8601 schedule time with timezone, e.g. '2026-04-26T15:00:00Z'."),
      },
      outputSchema: PostRecordShape,
      annotations: {
        title: "Update tweet draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ post_id, content, scheduled_at }, extra) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")

      const updates: string[] = ["updated_at = datetime('now')"]
      const params: unknown[] = []
      if (content) { updates.push("content = ?"); params.push(content) }
      if (scheduled_at) { updates.push("scheduled_at = ?"); params.push(scheduled_at) }
      params.push(post_id)

      db.prepare(`UPDATE twitter_posts SET ${updates.join(", ")} WHERE id = ?`).run(...params)
      const updated = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(post_id) as PostRecord
      const synced = await syncAndPersist(db, updated, extra.requestInfo?.headers)
      return success(synced as unknown as Record<string, unknown>)
    },
  )

  server.registerTool(
    "twitter_list_posts",
    {
      title: "List tweets",
      description: `List local tweet records ordered by created_at DESC. (Local Holaboss-managed posts only — does NOT list arbitrary tweets from X.)

When to use: find a specific draft, audit recent activity, or filter by lifecycle state.
Returns: array of PostRecord. Empty array if none match.`,
      inputSchema: {
        status: PostStatusEnum.optional().describe("Filter by lifecycle state. Omit to list all states."),
        limit: z.number().int().positive().max(200).optional().describe("Max results, default 20, max 200."),
      },
      annotations: {
        title: "List tweets",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status, limit }) => {
      const db = getDb()
      const max = limit ?? 20
      let rows: PostRecord[]
      if (status) {
        rows = db
          .prepare("SELECT * FROM twitter_posts WHERE status = ? ORDER BY created_at DESC LIMIT ?")
          .all(status, max) as PostRecord[]
      } else {
        rows = db.prepare("SELECT * FROM twitter_posts ORDER BY created_at DESC LIMIT ?").all(max) as PostRecord[]
      }
      return text(rows)
    },
  )

  server.registerTool(
    "twitter_get_post",
    {
      title: "Get tweet by id",
      description: `Fetch a single tweet record by id.

Prerequisites: post_id from twitter_create_post or twitter_list_posts.
Returns: full PostRecord including content, status, scheduled_at, published_at, error_message, output_id.
Errors: { code: 'not_found' } if post_id is unknown.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by twitter_create_post or twitter_list_posts."),
      },
      outputSchema: PostRecordShape,
      annotations: {
        title: "Get tweet by id",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ post_id }) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")
      return success(post as unknown as Record<string, unknown>)
    },
  )

  server.registerTool(
    "twitter_publish_post",
    {
      title: "Publish tweet",
      description: `Move a draft into the publish queue. If the draft has a future scheduled_at, the job is held until then; otherwise it fires within seconds.

When to use: the user has approved a draft and wants it posted to X (now or at the scheduled time).
Prerequisites: a draft created by twitter_create_post.
Side effects: status flips to 'queued'. The actual X API call happens asynchronously — poll twitter_get_publish_status until status is 'published' or 'failed'.
Returns: { job_id, status: 'queued' }.
Errors: { code: 'not_found' } if post_id is unknown. NOTE: re-calling on an already-queued post creates a duplicate job — call twitter_get_publish_status first if unsure.`,
      inputSchema: {
        post_id: z.string().describe("Draft post id to publish, returned by twitter_create_post."),
      },
      outputSchema: PublishResultShape,
      annotations: {
        title: "Publish tweet",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ post_id }, extra) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")

      const userId = process.env.HOLABOSS_USER_ID ?? ""
      const jobId = await enqueuePublish({
        post_id,
        content: post.content,
        holaboss_user_id: userId,
        scheduled_at: post.scheduled_at,
      })

      db.prepare("UPDATE twitter_posts SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(post_id)
      const updated = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(post_id) as PostRecord
      await syncAndPersist(db, updated, extra.requestInfo?.headers)
      return success({ job_id: jobId, status: "queued" as const })
    },
  )

  server.registerTool(
    "twitter_get_publish_status",
    {
      title: "Get publish status",
      description: `Read the current publish status of a tweet without mutating it.

When to use: after twitter_publish_post, poll until status is 'published' (success) or 'failed' (error_message will explain).
Returns: { status, error_message?, published_at?, updated_at }.
States: 'draft' | 'queued' | 'scheduled' | 'published' | 'failed'.
Errors: { code: 'not_found' } if post_id is unknown.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by twitter_create_post or twitter_publish_post."),
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
        .prepare("SELECT status, error_message, published_at, updated_at FROM twitter_posts WHERE id = ?")
        .get(post_id) as Record<string, unknown> | undefined
      if (!post) return errCode("not_found", "Post not found")
      return success(post)
    },
  )

  server.registerTool(
    "twitter_cancel_publish",
    {
      title: "Cancel publish",
      description: `Roll a queued or scheduled tweet back to 'draft' state. The publish job is dropped (not picked up by the worker). The local record is preserved — the tweet was never sent to X.

When to use: the user wants to stop a pending publish to edit further or abandon it before it goes live.
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
      const post = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")
      if (post.status !== "scheduled" && post.status !== "queued") {
        return errCode("invalid_state", `Cannot cancel post in '${post.status}' state`, { current_status: post.status, allowed_from: ["queued", "scheduled"] })
      }
      db.prepare("UPDATE twitter_posts SET status = 'draft', scheduled_at = NULL, updated_at = datetime('now') WHERE id = ?").run(post_id)
      const updated = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(post_id) as PostRecord
      await syncAndPersist(db, updated, extra.requestInfo?.headers)
      return success({ cancelled: true as const })
    },
  )

  server.registerTool(
    "twitter_delete_post",
    {
      title: "Delete tweet record",
      description: `Permanently delete a local tweet record. Cannot be undone. Does NOT delete a tweet that has already been posted to X — only removes our local copy.

When to use: throw away a draft or a failed attempt the user no longer wants in their list.
Valid states: 'draft' or 'failed'. For 'queued' / 'scheduled', call twitter_cancel_publish first to roll back to 'draft'. 'published' cannot be deleted.
Returns: { deleted: true, post_id }.
Errors: { code: 'not_found' } if post_id is unknown; { code: 'invalid_state', current_status, hint? } if status is 'queued' / 'scheduled' / 'published'.`,
      inputSchema: {
        post_id: z.string().describe("Draft or failed post id to delete."),
      },
      outputSchema: DeleteResultShape,
      annotations: {
        title: "Delete tweet record",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ post_id }) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")
      if (post.status === "queued" || post.status === "scheduled") return errCode("invalid_state", `Cannot delete post in '${post.status}' state. Cancel it first.`, { current_status: post.status, hint: "call twitter_cancel_publish first" })
      if (post.status === "published") return errCode("invalid_state", "Cannot delete a published post", { current_status: "published" })
      db.prepare("DELETE FROM twitter_posts WHERE id = ?").run(post_id)
      if (post.output_id) {
        try {
          await updateAppOutput(post.output_id, { status: "deleted" })
        } catch (syncError) {
          console.error(`[mcp] twitter output mark-deleted failed for post ${post_id}:`, syncError)
        }
      }
      return success({ deleted: true as const, post_id })
    },
  )

  server.registerTool(
    "twitter_get_queue_stats",
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

  server.registerTool(
    "twitter_send_dm",
    {
      title: "Send X direct message",
      description: `Send a direct message to a specific X user, identified by their numeric user id.

When to use: the user has the recipient's numeric X user id (visible in the URL of their X DM thread, or supplied externally) and wants to send them a private message. Works for both initiating a new DM conversation AND continuing an existing one — same endpoint covers both cases.
When NOT to use: you only have a username/handle (this tool does not look up handles). To draft a public tweet (use twitter_create_post). To send to multiple recipients (call this tool once per recipient).
Returns: { dm_event_id, dm_conversation_id }. The DM is sent immediately (no draft / queue / schedule). dm_conversation_id can be used to identify the same thread on subsequent reads.
Prerequisites: a connected X account with DM scope (dm.read + dm.write). X API DMs require Basic tier or higher.
Errors: { code: 'validation_failed' } when participant_id is empty, text is empty, or text exceeds the 10000-character X limit; the error fires up-front without burning a quota call. { code: 'not_found' } when the user id doesn't exist OR you can't DM them (e.g. they don't follow you and have DMs from non-followers off). { code: 'not_connected' } when the X token is missing the dm.write scope or is expired. { code: 'rate_limited' } with retry_after when X surfaces 429. { code: 'upstream_error' } for 5xx.`,
      inputSchema: {
        participant_id: z
          .string()
          .min(1)
          .describe("Recipient's numeric X user id. NOT the @handle. e.g. '1234567890'."),
        text: z
          .string()
          .min(1)
          .max(10_000)
          .describe("DM body. Hard limit 10000 chars (X v2 DM limit). Empty string is rejected."),
      },
      outputSchema: SendDmResultShape,
      annotations: {
        title: "Send X direct message",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ participant_id, text }) => {
      const result = await sendDirectMessage({ participant_id, text })
      if (!result.ok) {
        const extra: Record<string, unknown> = {}
        if (result.error.retry_after !== undefined) extra.retry_after = result.error.retry_after
        return errCode(result.error.code, result.error.message, extra)
      }
      return success(result.data as unknown as Record<string, unknown>)
    },
  )

  server.registerTool(
    "twitter_list_dms",
    {
      title: "List DM events with a user",
      description: `List recent DM events from the conversation with a specific X user, identified by their numeric user id.

When to use: the user wants to read the chat history with a specific person on X — to catch up before replying, to extract context, or to check if a previous message was delivered.
When NOT to use: to list all DM threads in the inbox (this tool is per-recipient only). To search messages by content (X API does not support that).
Returns: { messages, result_count, next_pagination_token? }. messages is an array of DmEvent ordered newest-first per X. Each event has { dm_event_id, dm_conversation_id, event_type, text?, sender_id?, created_at? }. event_type is usually 'MessageCreate' for actual messages but can be 'ParticipantsJoin' / 'ParticipantsLeave' on group threads — filter to 'MessageCreate' if you only want chat content. Compare sender_id to the connected X user's id to tell whose message it is.
Prerequisites: a connected X account with DM scope (dm.read).
Errors: { code: 'validation_failed' } when participant_id is empty. { code: 'not_found' } when the user id doesn't exist OR no DM conversation has ever existed with them. { code: 'not_connected' } when the X token is missing dm.read or is expired. { code: 'rate_limited' } with retry_after when X surfaces 429. { code: 'upstream_error' } for 5xx.`,
      inputSchema: {
        participant_id: z
          .string()
          .min(1)
          .describe("The other user's numeric X user id. NOT the @handle."),
        max_results: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Page size. Default 50, max 100 (X cap). Smaller is friendlier on agent token budgets."),
        pagination_token: z
          .string()
          .optional()
          .describe("Opaque token from the previous call's `next_pagination_token` to fetch the next page."),
      },
      outputSchema: ListDmsResultShape,
      annotations: {
        title: "List DM events with a user",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ participant_id, max_results, pagination_token }) => {
      const result = await listDirectMessages({ participant_id, max_results, pagination_token })
      if (!result.ok) {
        const extra: Record<string, unknown> = {}
        if (result.error.retry_after !== undefined) extra.retry_after = result.error.retry_after
        return errCode(result.error.code, result.error.message, extra)
      }
      return success(result.data as unknown as Record<string, unknown>)
    },
  )

  server.registerTool(
    "twitter_list_recent_dm_events",
    {
      title: "List recent DM events across all conversations",
      description: `List recent DM events from the connected X account's inbox — across every conversation, not scoped to a single recipient. Each event includes the sender's handle and display name inlined.

When to use: discover whose DMs need attention WITHOUT having a recipient id up-front — "do I have any new DMs?", "summarise my recent DM activity", "list everyone who messaged me today". ALSO use this BEFORE twitter_lookup_user_by_handle when the user names someone by @handle: if the handle appears in this response's \`senders\` array, you already have their numeric user_id and can skip the lookup hop.
When NOT to use: to read the full chat history with one specific person (use twitter_list_dms with their participant_id). To send a DM (use twitter_send_dm).
Returns: { messages, senders, result_count, next_pagination_token? }.
  - \`messages\`: list of DmEventEnriched newest-first per X. Each event: { dm_event_id, dm_conversation_id, event_type, text?, sender_id?, sender_handle?, sender_name?, created_at? }. event_type is usually 'MessageCreate' but can be 'ParticipantsJoin' / 'ParticipantsLeave' on group threads — pass event_types: ['MessageCreate'] to filter the join/leave noise out.
  - \`senders\`: per-sender rollup of \`messages\`, deduped by user_id, sorted by each sender's most recent event. Each entry has { user_id, handle?, name?, event_count, last_event_at?, last_message_text?, last_dm_conversation_id? }. This is the field to scan when matching a known @handle to a numeric user_id — \`user_id\` plugs straight into twitter_send_dm / twitter_list_dms as participant_id.
  - The connected user's own outgoing messages also appear in both \`messages\` and \`senders\` (compare to the connected account's handle to tell incoming from outgoing).
Prerequisites: a connected X account with DM scope (dm.read).
Errors: { code: 'not_connected' } when the X token is missing dm.read or expired. { code: 'rate_limited' } with retry_after on 429. { code: 'upstream_error' } on 5xx.`,
      inputSchema: {
        max_results: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Page size. Default 50, max 100 (X cap)."),
        event_types: z
          .array(z.enum(["MessageCreate", "ParticipantsJoin", "ParticipantsLeave"]))
          .optional()
          .describe("Filter to specific event types. Pass ['MessageCreate'] to skip group join/leave noise. Omit to get everything."),
        pagination_token: z
          .string()
          .optional()
          .describe("Opaque token from the previous call's `next_pagination_token`."),
      },
      outputSchema: ListRecentDmEventsResultShape,
      annotations: {
        title: "List recent DM events across all conversations",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ max_results, event_types, pagination_token }) => {
      const result = await listRecentDmEvents({ max_results, event_types, pagination_token })
      if (!result.ok) {
        const extra: Record<string, unknown> = {}
        if (result.error.retry_after !== undefined) extra.retry_after = result.error.retry_after
        return errCode(result.error.code, result.error.message, extra)
      }
      return success(result.data as unknown as Record<string, unknown>)
    },
  )

  server.registerTool(
    "twitter_lookup_user_by_handle",
    {
      title: "Resolve @handle to X user id",
      description: `Look up an X user by their @handle and return the numeric user_id needed by every other DM tool.

When to use: you have a handle like '@joshua' (or 'joshua') and need a numeric id, AND you've already checked twitter_list_recent_dm_events without finding the handle there. This is the fallback path — the inbox lookup is cheaper because the senders summary already inlines user_id for anyone who's DM'd recently.
When NOT to use: you already have the numeric id, OR the person has DM'd you recently and their entry appears in twitter_list_recent_dm_events' \`senders\` array (use that user_id directly — it saves a round trip). To search for users by display name or content (this is exact-handle only).
Returns: { user_id, username, name? }. user_id plugs straight into twitter_send_dm / twitter_list_dms as participant_id. username is the canonical form (X may correct casing).
Prerequisites: a connected X account; this endpoint uses the standard read scope, no DM scope required.
Errors: { code: 'validation_failed' } when handle is empty or malformed (handles are alphanumeric + underscore, max 15 chars). { code: 'not_found' } when X has no user with that handle. { code: 'not_connected' } on 401/403. { code: 'rate_limited' } with retry_after on 429. { code: 'upstream_error' } on 5xx.`,
      inputSchema: {
        handle: z
          .string()
          .min(1)
          .describe("X handle. With or without leading '@'. Case-insensitive on X's side."),
      },
      outputSchema: LookupUserResultShape,
      annotations: {
        title: "Resolve @handle to X user id",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ handle }) => {
      const result = await lookupUserByHandle({ handle })
      if (!result.ok) {
        const extra: Record<string, unknown> = {}
        if (result.error.retry_after !== undefined) extra.retry_after = result.error.retry_after
        return errCode(result.error.code, result.error.message, extra)
      }
      return success(result.data as unknown as Record<string, unknown>)
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
