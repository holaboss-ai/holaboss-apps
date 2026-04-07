import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { z } from "zod"

import type { PostRecord } from "../lib/types"
import { REDDIT_CONFIG } from "../lib/types"
import { syncPostDraftArtifact } from "./app-outputs"
import { getDb } from "./db"
import { resolveHolabossTurnContext } from "./holaboss-bridge"
import { enqueuePublish, getQueueStats } from "./queue"

function text(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] } }
function err(message: string) { return { content: [{ type: "text" as const, text: message }], isError: true } }

function persistOutputId(db: ReturnType<typeof getDb>, postId: string, outputId: string) {
  db.prepare("UPDATE posts SET output_id = ? WHERE id = ?").run(outputId, postId)
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: `${REDDIT_CONFIG.name} Module`,
    version: "1.0.0",
  })

  server.tool("reddit_create_post", "Create a new Reddit post draft", {
    title: z.string().max(300).describe("Post title (max 300 characters)"),
    content: z.string().describe("Post body (markdown supported)"),
    subreddit: z.string().describe("Target subreddit (without r/ prefix)"),
    scheduled_at: z.string().optional().describe("ISO 8601 schedule time"),
  }, async ({ title, content, subreddit, scheduled_at }, extra) => {
    try {
      const db = getDb()
      const id = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO posts (id, title, content, subreddit, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
      ).run(id, title, content, subreddit, scheduled_at ?? null, now, now)

      let post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRecord
      const context = resolveHolabossTurnContext(extra.requestInfo?.headers)
      if (context) {
        try {
          const outputId = await syncPostDraftArtifact(post, context)
          if (outputId && outputId !== post.output_id) {
            persistOutputId(db, post.id, outputId)
            post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRecord
          }
        } catch (artifactError) {
          db.prepare("DELETE FROM posts WHERE id = ?").run(id)
          throw artifactError
        }
      }

      return text(post)
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error))
    }
  })

  server.tool("reddit_update_post", "Update a draft Reddit post", {
    post_id: z.string().describe("Post ID"),
    title: z.string().optional().describe("New title"),
    content: z.string().optional().describe("New body"),
    subreddit: z.string().optional().describe("New target subreddit"),
    scheduled_at: z.string().optional().describe("New schedule time"),
  }, async ({ post_id, title, content, subreddit, scheduled_at }) => {
    const db = getDb()
    const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
    if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }

    const updates: string[] = ["updated_at = datetime('now')"]
    const params: unknown[] = []
    if (title) { updates.push("title = ?"); params.push(title) }
    if (content) { updates.push("content = ?"); params.push(content) }
    if (subreddit) { updates.push("subreddit = ?"); params.push(subreddit) }
    if (scheduled_at) { updates.push("scheduled_at = ?"); params.push(scheduled_at) }
    params.push(post_id)

    db.prepare(`UPDATE posts SET ${updates.join(", ")} WHERE id = ?`).run(...params)
    const updated = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id)
    return { content: [{ type: "text" as const, text: JSON.stringify(updated) }] }
  })

  server.tool("reddit_list_posts", "List Reddit posts", {
    status: z.string().optional().describe("Filter by status"),
    subreddit: z.string().optional().describe("Filter by subreddit"),
    limit: z.number().optional().describe("Max results, default 20"),
  }, async ({ status, subreddit, limit }) => {
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
    return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] }
  })

  server.tool("reddit_get_post", "Get a specific Reddit post by ID", {
    post_id: z.string().describe("Post ID"),
  }, async ({ post_id }) => {
    const db = getDb()
    const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id)
    if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }
    return { content: [{ type: "text" as const, text: JSON.stringify(post) }] }
  })

  server.tool("reddit_publish_post", "Publish a Reddit post immediately or schedule it", {
    post_id: z.string().describe("Post ID to publish"),
  }, async ({ post_id }) => {
    const db = getDb()
    const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
    if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }

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
    return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: jobId, status: "queued" }) }] }
  })

  server.tool("reddit_get_publish_status", "Check publish status of a Reddit post", {
    post_id: z.string().describe("Post ID"),
  }, async ({ post_id }) => {
    const db = getDb()
    const post = db.prepare("SELECT status, error_message, published_at, updated_at FROM posts WHERE id = ?").get(post_id)
    if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }
    return { content: [{ type: "text" as const, text: JSON.stringify(post) }] }
  })

  server.tool("reddit_cancel_publish", "Cancel a scheduled Reddit post", {
    post_id: z.string().describe("Post ID to cancel"),
  }, async ({ post_id }) => {
    const db = getDb()
    const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
    if (!post) return { content: [{ type: "text" as const, text: "Post not found" }], isError: true }
    if (post.status !== "scheduled" && post.status !== "queued") {
      return { content: [{ type: "text" as const, text: `Cannot cancel post in '${post.status}' state` }], isError: true }
    }
    db.prepare("UPDATE posts SET status = 'draft', scheduled_at = NULL, updated_at = datetime('now') WHERE id = ?").run(post_id)
    return { content: [{ type: "text" as const, text: JSON.stringify({ cancelled: true }) }] }
  })

  server.tool("reddit_delete_post", "Delete a Reddit post draft. Only draft or failed posts can be deleted.", {
    post_id: z.string().describe("Post ID to delete"),
  }, async ({ post_id }) => {
    const db = getDb()
    const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(post_id) as PostRecord | undefined
    if (!post) return err("Post not found")
    if (post.status === "queued" || post.status === "scheduled") return err(`Cannot delete post in '${post.status}' state. Cancel it first.`)
    if (post.status === "published") return err("Cannot delete a published post")
    db.prepare("DELETE FROM posts WHERE id = ?").run(post_id)
    return text({ deleted: true, post_id })
  })

  server.tool("reddit_get_queue_stats", "Get Reddit publish queue statistics", {}, async () => {
    const stats = await getQueueStats()
    return { content: [{ type: "text" as const, text: JSON.stringify(stats) }] }
  })

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
