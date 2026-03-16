import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { z } from "zod"

import type { PostRecord } from "../lib/types"
import { MODULE_CONFIG } from "../lib/types"
import { getDb } from "./db"
import { enqueuePublish, getQueueStats } from "./queue"

// TODO: Replace "module" prefix in all tool names with your module name (e.g., "linkedin", "crm")
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: `${MODULE_CONFIG.name} Module`,
    version: "1.0.0",
  })

  server.tool("module_create_post", "Create a new draft", {
    content: z.string().describe("Content"),
    scheduled_at: z.string().optional().describe("ISO 8601 schedule time"),
  }, async ({ content, scheduled_at }) => {
    const db = getDb()
    const id = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO posts (id, content, status, scheduled_at, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?)",
    ).run(id, content, scheduled_at ?? null, now, now)
    return { content: [{ type: "text" as const, text: JSON.stringify({ id, content, status: "draft", scheduled_at }) }] }
  })

  server.tool("module_list_posts", "List posts", {
    status: z.string().optional().describe("Filter by status"),
    limit: z.number().optional().describe("Max results, default 20"),
  }, async ({ status, limit }) => {
    const db = getDb()
    const max = limit ?? 20
    let rows: PostRecord[]
    if (status) {
      rows = db.prepare("SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, max) as PostRecord[]
    } else {
      rows = db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?").all(max) as PostRecord[]
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] }
  })

  server.tool("module_get_post", "Get a specific post by ID", {
    post_id: z.string().describe("Post ID"),
  }, async ({ post_id }) => {
    const db = getDb()
    const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id)
    if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }
    return { content: [{ type: "text" as const, text: JSON.stringify(post) }] }
  })

  server.tool("module_publish_post", "Publish a post", {
    post_id: z.string().describe("Post ID to publish"),
  }, async ({ post_id }) => {
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
  })

  server.tool("module_get_publish_status", "Check publish status", {
    post_id: z.string().describe("Post ID"),
  }, async ({ post_id }) => {
    const db = getDb()
    const post = db.prepare("SELECT status, error_message, published_at, updated_at FROM posts WHERE id = ?").get(post_id)
    if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }
    return { content: [{ type: "text" as const, text: JSON.stringify(post) }] }
  })

  server.tool("module_get_queue_stats", "Get publish queue statistics", {}, async () => {
    const stats = await getQueueStats()
    return { content: [{ type: "text" as const, text: JSON.stringify(stats) }] }
  })

  // TODO: Add more platform-specific tools here

  return server
}

export function startMcpServer(port: number) {
  const mcpServer = createMcpServer()
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
