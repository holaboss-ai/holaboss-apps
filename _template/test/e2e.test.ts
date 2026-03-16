import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"

import type { PostRecord } from "../src/lib/types"

let mcpServer: Server | null = null
const MCP_PORT = 13099

// TODO: Replace "Module Template" with your module name in describe blocks

describe("Module Template E2E", () => {
  beforeAll(async () => {
    process.env.DB_PATH = "/tmp/module-template-e2e-test.db"

    const { startMcpServer } = await import("../src/server/mcp")
    mcpServer = startMcpServer(MCP_PORT)
    await waitForServer(`http://localhost:${MCP_PORT}/mcp/health`)
  }, 15_000)

  afterAll(async () => {
    if (mcpServer) {
      await new Promise<void>((resolve) => mcpServer!.close(() => resolve()))
      mcpServer = null
    }
    const fs = await import("node:fs")
    try { fs.unlinkSync("/tmp/module-template-e2e-test.db") } catch { /* ok */ }
  })

  describe("Post CRUD", () => {
    let testPostId: string

    it("creates a draft post", async () => {
      const { getDb } = await import("../src/server/db")
      const { randomUUID } = await import("node:crypto")

      testPostId = randomUUID()
      const db = getDb()
      const now = new Date().toISOString()

      db.prepare(
        "INSERT INTO posts (id, content, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)",
      ).run(testPostId, "Test content", now, now)

      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(testPostId) as PostRecord
      expect(post.content).toBe("Test content")
      expect(post.status).toBe("draft")
    })

    it("updates a post", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      db.prepare(
        "UPDATE posts SET content = ?, updated_at = datetime('now') WHERE id = ?",
      ).run("Updated content", testPostId)

      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(testPostId) as PostRecord
      expect(post.content).toBe("Updated content")
    })

    it("lists posts by status", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const drafts = db
        .prepare("SELECT * FROM posts WHERE status = ?")
        .all("draft") as PostRecord[]
      expect(drafts.length).toBeGreaterThanOrEqual(1)
      expect(drafts.every((p) => p.status === "draft")).toBe(true)
    })

    it("deletes a post", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      db.prepare("DELETE FROM posts WHERE id = ?").run(testPostId)
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(testPostId)
      expect(post).toBeUndefined()
    })
  })

  describe("Full lifecycle", () => {
    it("create → queue → publish → delete", async () => {
      const { getDb } = await import("../src/server/db")
      const { randomUUID } = await import("node:crypto")
      const db = getDb()

      const id = randomUUID()
      const content = `E2E lifecycle ${Date.now()}`
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO posts (id, content, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)",
      ).run(id, content, now, now)

      const posts = db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT 10").all() as PostRecord[]
      expect(posts.find((p) => p.id === id)).toBeDefined()

      db.prepare("UPDATE posts SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(id)
      expect((db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRecord).status).toBe("queued")

      db.prepare(
        "UPDATE posts SET status = 'published', external_post_id = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      ).run("ext-123", id)
      const published = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRecord
      expect(published.status).toBe("published")
      expect(published.external_post_id).toBe("ext-123")

      db.prepare("DELETE FROM posts WHERE id = ?").run(id)
    })
  })

  describe("Publisher", () => {
    it("constructs without error", async () => {
      const { ModulePublisher } = await import("../src/server/publisher")
      expect(new ModulePublisher()).toBeDefined()
    })

    it("rejects publish when integration ID is missing", async () => {
      const { ModulePublisher } = await import("../src/server/publisher")
      await expect(
        new ModulePublisher().publish({ holaboss_user_id: "test", content: "test" }),
      ).rejects.toThrow("missing_integration_id")
    })
  })

  describe("MCP server", () => {
    it("health check responds ok", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/mcp/health`)
      expect(res.ok).toBe(true)
      expect((await res.json()).status).toBe("ok")
    })

    it("SSE endpoint returns event stream", async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      try {
        const res = await fetch(`http://localhost:${MCP_PORT}/mcp/sse`, { signal: controller.signal })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("text/event-stream")
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") throw err
      } finally {
        clearTimeout(timeout)
      }
    })

    it("returns 404 for unknown paths", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/mcp/unknown`)
      expect(res.status).toBe(404)
    })
  })

  describe("Queue", () => {
    it("enqueuePublish creates a job and getQueueStats reflects it", async () => {
      const { enqueuePublish, getQueueStats } = await import("../src/server/queue")

      const jobId = enqueuePublish({
        post_id: "test-post-queue",
        content: "test content",
        holaboss_user_id: "test-user",
      })
      expect(typeof jobId).toBe("string")

      const stats = getQueueStats()
      expect(stats).toHaveProperty("waiting")
      expect(stats).toHaveProperty("active")
      expect(stats).toHaveProperty("completed")
      expect(stats).toHaveProperty("failed")
      expect(stats).toHaveProperty("delayed")
      expect(stats.waiting).toBeGreaterThanOrEqual(1)
    })

    it("enqueuePublish with future scheduled_at creates a delayed job", async () => {
      const { enqueuePublish, getQueueStats } = await import("../src/server/queue")
      const { getDb } = await import("../src/server/db")

      const futureDate = new Date(Date.now() + 86_400_000).toISOString()
      const jobId = enqueuePublish({
        post_id: "test-post-delayed",
        content: "scheduled content",
        holaboss_user_id: "test-user",
        scheduled_at: futureDate,
      })

      const db = getDb()
      const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as { status: string }
      expect(job.status).toBe("delayed")

      const stats = getQueueStats()
      expect(stats.delayed).toBeGreaterThanOrEqual(1)
    })
  })

  describe("Platform config", () => {
    it("MODULE_CONFIG has values set", async () => {
      const { MODULE_CONFIG } = await import("../src/lib/types")
      expect(MODULE_CONFIG.provider).toBeDefined()
      expect(MODULE_CONFIG.destination).toBeDefined()
      expect(MODULE_CONFIG.name).toBeDefined()
    })
  })
})

async function waitForServer(url: string, timeoutMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`)
}
