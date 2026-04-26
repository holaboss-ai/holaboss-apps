import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { z } from "zod"

import type { PostRecord } from "../lib/types"
import { MODULE_CONFIG } from "../lib/types"
import { getDb } from "./db"
import { enqueuePublish, getQueueStats } from "./queue"

// Canonical reference for the MCP tool description convention.
// Spec: ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md
// When you copy this template, also rewrite each description for your module.
// TODO: Replace "module" prefix in every tool name with your module name (e.g. "linkedin", "crm").

type ErrorCode =
  | "not_found"
  | "invalid_state"
  | "validation_failed"
  | "not_connected"
  | "rate_limited"
  | "upstream_error"
  | "internal"

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}
function success<T extends Record<string, unknown>>(data: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data }
}
function errCode(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ code, message, ...extra }) }], isError: true as const }
}

// Output shapes — copy and tailor to your module's domain.
const PostStatusEnum = z.enum(["draft", "queued", "scheduled", "published", "failed"])
const PostRecordShape = {
  id: z.string(),
  content: z.string(),
  status: PostStatusEnum,
  scheduled_at: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  external_post_id: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
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
const QueueStatsShape = {
  waiting: z.number(),
  active: z.number(),
  completed: z.number(),
  failed: z.number(),
  delayed: z.number(),
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: `${MODULE_CONFIG.name} Module`,
    version: "1.0.0",
  })

  server.registerTool(
    "module_create_post",
    {
      title: "Create draft",
      description: `Create a new post in 'draft' state. Stored locally — NOT published.

When to use: the user asks to compose, draft, or write a post for this module.
When NOT to use: to publish an existing draft (use module_publish_post). To edit a draft (use module_update_post if exposed).
Returns: PostRecord { id, content, status: 'draft', scheduled_at?, created_at, updated_at }.
Sibling: pass scheduled_at if you want the publish job delayed; you still must call module_publish_post to commit.`,
      inputSchema: {
        content: z.string().describe("Post body. Replace this with your platform's char-limit + format constraints."),
        scheduled_at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 with timezone, e.g. '2026-04-26T15:00:00Z'. Stored on the draft only; module_publish_post is what actually schedules it.",
          ),
      },
      outputSchema: PostRecordShape,
      annotations: {
        title: "Create draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ content, scheduled_at }) => {
      const db = getDb()
      const id = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO posts (id, content, status, scheduled_at, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)",
      ).run(id, content, scheduled_at ?? null, now, now)
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRecord
      return success(post as unknown as Record<string, unknown>)
    },
  )

  server.registerTool(
    "module_list_posts",
    {
      title: "List posts",
      description: `List posts ordered by created_at DESC.

When to use: the agent needs to find a specific post or audit recent activity.
Returns: array of PostRecord. Empty array if none match.`,
      inputSchema: {
        status: PostStatusEnum.optional().describe("Filter by lifecycle state. Omit to list all."),
        limit: z.number().int().positive().max(200).optional().describe("Max results, default 20, max 200."),
      },
      annotations: {
        title: "List posts",
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
          .prepare("SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC LIMIT ?")
          .all(status, max) as PostRecord[]
      } else {
        rows = db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?").all(max) as PostRecord[]
      }
      return text(rows)
    },
  )

  server.registerTool(
    "module_get_post",
    {
      title: "Get post by id",
      description: `Fetch a single post by id.

Prerequisites: post_id from module_list_posts or module_create_post.
Returns: full PostRecord.
Errors: { code: 'not_found' } if post_id is unknown.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by module_create_post or module_list_posts."),
      },
      outputSchema: PostRecordShape,
      annotations: {
        title: "Get post by id",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ post_id }) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")
      return success(post as unknown as Record<string, unknown>)
    },
  )

  server.registerTool(
    "module_publish_post",
    {
      title: "Publish post",
      description: `Move a draft into the publish queue. If the draft has a future scheduled_at, the job is held until then; otherwise it fires within seconds.

When to use: the user has approved a draft and wants it published (or scheduled).
Prerequisites: a draft created by module_create_post.
Side effects: status flips to 'queued' (or 'scheduled' if dated future). Actual publishing is async — poll module_get_publish_status for outcome.
Returns: { job_id, status: 'queued' }.
Errors: { code: 'not_found' } if post_id is unknown. NOTE: re-publishing an already-queued post creates a duplicate job — call module_get_publish_status first if unsure.`,
      inputSchema: {
        post_id: z.string().describe("Draft post id to publish, returned by module_create_post."),
      },
      outputSchema: PublishResultShape,
      annotations: {
        title: "Publish post",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ post_id }) => {
      const db = getDb()
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
      if (!post) return errCode("not_found", "Post not found")

      const userId = process.env.HOLABOSS_USER_ID ?? ""
      const jobId = await enqueuePublish({
        post_id,
        content: post.content,
        holaboss_user_id: userId,
        scheduled_at: post.scheduled_at,
      })

      db.prepare("UPDATE posts SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(post_id)
      return success({ job_id: jobId, status: "queued" as const })
    },
  )

  server.registerTool(
    "module_get_publish_status",
    {
      title: "Get publish status",
      description: `Read current publish status without mutating the post.

When to use: after module_publish_post, poll until status is 'published' or 'failed'.
Returns: { status, error_message?, published_at?, updated_at }.
States: 'draft' | 'queued' | 'scheduled' | 'published' | 'failed'.
Errors: { code: 'not_found' } if post_id is unknown.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by module_create_post or module_publish_post."),
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
        .prepare("SELECT status, error_message, published_at, updated_at FROM posts WHERE id = ?")
        .get(post_id) as Record<string, unknown> | undefined
      if (!post) return errCode("not_found", "Post not found")
      return success(post)
    },
  )

  server.registerTool(
    "module_get_queue_stats",
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

  // TODO: Add platform-specific tools below (e.g. module_update_post, module_cancel_publish, module_delete_post).
  // Follow the convention in docs/MCP_TOOL_DESCRIPTION_CONVENTION.md.

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
      const server = createMcpServer()
      await server.connect(transport)
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
