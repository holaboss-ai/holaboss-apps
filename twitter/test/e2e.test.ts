import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"

import type { PostRecord } from "../src/lib/types"

let mcpServer: Server | null = null
const MCP_PORT = 13099 // Test port to avoid conflicts

describe("Twitter Module E2E", () => {
  beforeAll(async () => {
    // Set test DB path
    process.env.DB_PATH = "/tmp/twitter-module-e2e-test.db"

    // Start MCP server for testing
    const { startMcpServer } = await import("../src/server/mcp")
    mcpServer = startMcpServer(MCP_PORT)

    // Wait for MCP server to be ready
    await waitForServer(`http://localhost:${MCP_PORT}/mcp/health`)
  }, 15_000)

  afterAll(async () => {
    if (mcpServer) {
      await new Promise<void>((resolve) => mcpServer!.close(() => resolve()))
      mcpServer = null
    }
    // Clean up test DB
    const fs = await import("node:fs")
    try { fs.unlinkSync("/tmp/twitter-module-e2e-test.db") } catch { /* ok */ }
  })

  // --- SQLite CRUD ---

  describe("Post CRUD", () => {
    let testPostId: string

    it("creates a draft post", async () => {
      const { getDb } = await import("../src/server/db")
      const { randomUUID } = await import("node:crypto")

      testPostId = randomUUID()
      const db = getDb()
      const now = new Date().toISOString()

      db.prepare(
        "INSERT INTO twitter_posts (id, content, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)",
      ).run(testPostId, "Test tweet content", now, now)

      const post = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(testPostId) as PostRecord
      expect(post.content).toBe("Test tweet content")
      expect(post.status).toBe("draft")
    })

    it("updates a post", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      db.prepare(
        "UPDATE twitter_posts SET content = ?, updated_at = datetime('now') WHERE id = ?",
      ).run("Updated tweet", testPostId)

      const post = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(testPostId) as PostRecord
      expect(post.content).toBe("Updated tweet")
    })

    it("lists posts by status", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      const drafts = db
        .prepare("SELECT * FROM twitter_posts WHERE status = ?")
        .all("draft") as PostRecord[]
      expect(drafts.length).toBeGreaterThanOrEqual(1)
      expect(drafts.every((p) => p.status === "draft")).toBe(true)
    })

    it("deletes a post", async () => {
      const { getDb } = await import("../src/server/db")
      const db = getDb()

      db.prepare("DELETE FROM twitter_posts WHERE id = ?").run(testPostId)
      const post = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(testPostId)
      expect(post).toBeUndefined()
    })
  })

  // --- Full lifecycle ---

  describe("Full draft lifecycle", () => {
    it("create → update status → verify → delete", async () => {
      const { getDb } = await import("../src/server/db")
      const { randomUUID } = await import("node:crypto")
      const db = getDb()

      // Create
      const id = randomUUID()
      const content = `E2E lifecycle ${Date.now()}`
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO twitter_posts (id, content, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)",
      ).run(id, content, now, now)

      // Verify in list
      const posts = db.prepare("SELECT * FROM twitter_posts ORDER BY created_at DESC LIMIT 10").all() as PostRecord[]
      expect(posts.find((p) => p.id === id)).toBeDefined()

      // Update status to queued
      db.prepare("UPDATE twitter_posts SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(id)
      const queued = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(id) as PostRecord
      expect(queued.status).toBe("queued")

      // Simulate publish success
      db.prepare(
        "UPDATE twitter_posts SET status = 'published', external_post_id = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      ).run("ext-123", id)
      const published = db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(id) as PostRecord
      expect(published.status).toBe("published")
      expect(published.external_post_id).toBe("ext-123")

      // Cleanup
      db.prepare("DELETE FROM twitter_posts WHERE id = ?").run(id)
    })
  })

  // --- Publisher ---

  describe("TwitterPublisher", () => {
    it("constructs without error", async () => {
      const { TwitterPublisher } = await import("../src/server/publisher")
      const publisher = new TwitterPublisher()
      expect(publisher).toBeDefined()
    })

    it("rejects publish when integration ID is missing", async () => {
      const { TwitterPublisher } = await import("../src/server/publisher")
      const publisher = new TwitterPublisher()

      await expect(
        publisher.publish({
          holaboss_user_id: "test-user",
          content: "test tweet",
        }),
      ).rejects.toThrow("missing_integration_id")
    })
  })

  // --- MCP Server ---

  describe("MCP server", () => {
    it("health check responds ok", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/mcp/health`)
      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(body.status).toBe("ok")
    })

    it("SSE endpoint returns event stream", async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)

      try {
        const res = await fetch(`http://localhost:${MCP_PORT}/mcp/sse`, {
          signal: controller.signal,
        })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("text/event-stream")
      } catch (err) {
        // AbortError is expected — SSE keeps connection open
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

  // --- Queue (SQLite) ---

  describe("Queue", () => {
    it("enqueuePublish creates a job and getQueueStats reflects it", async () => {
      const { enqueuePublish, getQueueStats } = await import("../src/server/queue")

      const jobId = enqueuePublish({
        post_id: "test-post-queue",
        content: "test tweet",
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

      const futureDate = new Date(Date.now() + 86_400_000).toISOString() // +1 day
      const jobId = enqueuePublish({
        post_id: "test-post-delayed",
        content: "scheduled tweet",
        holaboss_user_id: "test-user",
        scheduled_at: futureDate,
      })

      const db = getDb()
      const job = db.prepare("SELECT * FROM twitter_jobs WHERE id = ?").get(jobId) as { status: string }
      expect(job.status).toBe("delayed")

      const stats = getQueueStats()
      expect(stats.delayed).toBeGreaterThanOrEqual(1)
    })
  })

  // --- Platform config ---

  describe("Platform config", () => {
    it("TWITTER_CONFIG has correct values", async () => {
      const { TWITTER_CONFIG } = await import("../src/lib/types")
      expect(TWITTER_CONFIG.provider).toBe("twitter-xdnq")
      expect(TWITTER_CONFIG.destination).toBe("twitter")
      expect(TWITTER_CONFIG.name).toBe("Twitter/X")
    })
  })
})

// --- Helpers ---

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
