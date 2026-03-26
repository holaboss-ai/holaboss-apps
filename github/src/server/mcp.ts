import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createServer } from "node:http"
import { z } from "zod"

import { MODULE_CONFIG } from "../lib/types"
import {
  getCommit,
  getPullRequest,
  listRecentActivity,
  listReleases,
  listUserRepos,
} from "./github-api"

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true }
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: `${MODULE_CONFIG.name} Module`,
    version: "1.0.0",
  })

  server.tool(
    "github_list_repos",
    "List user's repositories sorted by recent activity",
    {
      username: z.string().optional().describe("GitHub username (omit for authenticated user)"),
      limit: z.number().optional().describe("Max results, default 10"),
    },
    async ({ username, limit }) => {
      try {
        const repos = await listUserRepos(username, limit ?? 10)
        return text(repos)
      } catch (e) {
        return err(`Failed to list repos: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.tool(
    "github_recent_activity",
    "Get recent commits, PRs, and releases for a repo",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      days: z.number().optional().describe("Number of days to look back, default 7"),
    },
    async ({ owner, repo, days }) => {
      try {
        const activity = await listRecentActivity(owner, repo, days ?? 7)
        return text(activity)
      } catch (e) {
        return err(`Failed to get activity: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.tool(
    "github_get_commit",
    "Get full commit details with file changes",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      sha: z.string().describe("Commit SHA"),
    },
    async ({ owner, repo, sha }) => {
      try {
        const commit = await getCommit(owner, repo, sha)
        if (!commit) return err("Commit not found")
        return text(commit)
      } catch (e) {
        return err(`Failed to get commit: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.tool(
    "github_get_pr",
    "Get pull request details",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      number: z.number().describe("Pull request number"),
    },
    async ({ owner, repo, number }) => {
      try {
        const pr = await getPullRequest(owner, repo, number)
        if (!pr) return err("Pull request not found")
        return text(pr)
      } catch (e) {
        return err(`Failed to get PR: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.tool(
    "github_list_releases",
    "List releases for a repo",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      limit: z.number().optional().describe("Max results, default 5"),
    },
    async ({ owner, repo, limit }) => {
      try {
        const releases = await listReleases(owner, repo, limit ?? 5)
        return text(releases)
      } catch (e) {
        return err(`Failed to list releases: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  return server
}

export function startMcpServer(port: number) {
  const server = createMcpServer()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }

    if (url.pathname === "/mcp") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)
      await transport.handleRequest(req, res)
      return
    }

    // Legacy SSE support (backward compatible)
    if (url.pathname === "/mcp/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  httpServer.listen(port, () => {
    console.log(`[GitHub] MCP server listening on port ${port}`)
  })

  return httpServer
}
