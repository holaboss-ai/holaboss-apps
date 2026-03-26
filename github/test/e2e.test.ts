import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"

let mcpServer: Server | null = null
const MCP_PORT = 13097
const TEST_DB_PATH = `/tmp/github-e2e-test-${Date.now()}.db`

describe("GitHub Module E2E", () => {
  beforeAll(async () => {
    process.env.DB_PATH = TEST_DB_PATH
    const { startMcpServer } = await import("../src/server/mcp")
    mcpServer = startMcpServer(MCP_PORT)
    await waitForServer(`http://localhost:${MCP_PORT}/health`)
  }, 15_000)

  afterAll(async () => {
    if (mcpServer) {
      mcpServer.closeAllConnections()
      await new Promise<void>((resolve) => mcpServer!.close(() => resolve()))
      mcpServer = null
    }
    const fs = await import("node:fs")
    try { fs.unlinkSync(TEST_DB_PATH) } catch {}
  }, 5_000)

  describe("MCP server", () => {
    it("health check responds ok", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/health`)
      expect(res.ok).toBe(true)
      expect((await res.json()).status).toBe("ok")
    })

    it("MCP endpoint accepts POST", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      })
      expect(res.status).toBe(200)
    })

    it("returns 404 for unknown paths", async () => {
      const res = await fetch(`http://localhost:${MCP_PORT}/unknown`)
      expect(res.status).toBe(404)
    })
  })

  describe("GitHub API client", () => {
    it("rejects when no token is set", async () => {
      const saved = process.env.PLATFORM_INTEGRATION_TOKEN
      delete process.env.PLATFORM_INTEGRATION_TOKEN
      const { listUserRepos } = await import("../src/server/github-api")
      await expect(listUserRepos()).rejects.toThrow("PLATFORM_INTEGRATION_TOKEN")
      process.env.PLATFORM_INTEGRATION_TOKEN = saved
    })
  })

  describe("Platform config", () => {
    it("MODULE_CONFIG has correct values", async () => {
      const { MODULE_CONFIG } = await import("../src/lib/types")
      expect(MODULE_CONFIG.provider).toBe("github")
      expect(MODULE_CONFIG.destination).toBe("github")
      expect(MODULE_CONFIG.name).toBe("GitHub")
    })
  })

  describe.skipIf(!process.env.GITHUB_TEST_TOKEN)("GitHub API integration", () => {
    beforeAll(() => {
      process.env.PLATFORM_INTEGRATION_TOKEN = process.env.GITHUB_TEST_TOKEN!
    })

    it("lists user repos", async () => {
      const { listUserRepos } = await import("../src/server/github-api")
      const repos = await listUserRepos(undefined, 3)
      expect(Array.isArray(repos)).toBe(true)
    })

    it("lists recent activity for a repo", async () => {
      const { listRecentActivity } = await import("../src/server/github-api")
      const testRepo = process.env.GITHUB_TEST_REPO ?? "holaboss-ai/holaboss-modules"
      const [owner, repo] = testRepo.split("/")
      const activity = await listRecentActivity(owner, repo, 30)
      expect(activity).toHaveProperty("commits")
      expect(activity).toHaveProperty("pull_requests")
      expect(activity).toHaveProperty("summary")
    })
  })
})

async function waitForServer(url: string, timeoutMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`)
}
