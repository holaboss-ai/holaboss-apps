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
      return { content: [{ type: "text" as const, text: JSON.stringify({ id, content, status: "draft", scheduled_at }) }] }
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
        status: z
          .string()
          .optional()
          .describe("Filter by status: 'draft' | 'queued' | 'scheduled' | 'published' | 'failed'. Omit to list all."),
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
      return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] }
    },
  )

  server.registerTool(
    "module_get_post",
    {
      title: "Get post by id",
      description: `Fetch a single post by id.

Prerequisites: post_id from module_list_posts or module_create_post.
Returns: full PostRecord.
Errors: isError=true with 'Post not found' if post_id is unknown.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by module_create_post or module_list_posts."),
      },
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
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id)
      if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }
      return { content: [{ type: "text" as const, text: JSON.stringify(post) }] }
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
Errors: 'Post not found'. NOTE: re-publishing an already-queued post creates a duplicate job — call module_get_publish_status first if unsure.`,
      inputSchema: {
        post_id: z.string().describe("Draft post id to publish, returned by module_create_post."),
      },
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
      if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }

      const userId = process.env.HOLABOSS_USER_ID ?? ""
      const jobId = await enqueuePublish({
        post_id,
        content: post.content,
        holaboss_user_id: userId,
        scheduled_at: post.scheduled_at,
      })

      db.prepare("UPDATE posts SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(post_id)
      return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: jobId, status: "queued" }) }] }
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
Errors: 'Post not found'.`,
      inputSchema: {
        post_id: z.string().describe("Post id returned by module_create_post or module_publish_post."),
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
      if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }
      return { content: [{ type: "text" as const, text: JSON.stringify(post) }] }
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
      return { content: [{ type: "text" as const, text: JSON.stringify(stats) }] }
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
