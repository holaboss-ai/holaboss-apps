import { createServer } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { z } from "zod"

import { MODULE_CONFIG } from "../lib/types"
import {
  getCommit,
  getPullRequest,
  listRecentActivity,
  listReleases,
  listUserRepos,
} from "./github-api"

// Tool descriptions follow ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md
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

  server.registerTool(
    "github_list_repos",
    {
      title: "List repos",
      description: `List a user's repositories ordered by recent push activity DESC.

When to use: discovery — "what repos does X own?" or list the authenticated user's repos.
Returns: array of { id, name, full_name, description, language, stars, forks, updated_at, html_url }.
Errors: "Failed to list repos: <gh error>" if username is invalid or rate-limited.`,
      inputSchema: {
        username: z
          .string()
          .optional()
          .describe("GitHub username, e.g. 'torvalds'. Omit to list the authenticated user's repos."),
        limit: z.number().int().positive().max(100).optional().describe("Max results, default 10, max 100."),
      },
      annotations: {
        title: "List repos",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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

  server.registerTool(
    "github_recent_activity",
    {
      title: "Recent repo activity",
      description: `Aggregate recent commits, merged PRs, and releases for a single repo over a time window.

When to use: "what happened in repo X recently?" — produces a digest for daily/weekly summaries.
When NOT to use: to read a single commit/PR's full body — use github_get_commit / github_get_pr after spotting it here.
Returns: { commits: [{ sha, author, message, date }], pull_requests: [{ number, title, state, merged_at, author }], releases: [{ tag, name, published_at }] }.`,
      inputSchema: {
        owner: z.string().describe("Repository owner login, e.g. 'anthropics' or 'torvalds'."),
        repo: z.string().describe("Repository name without owner, e.g. 'claude-code' or 'linux'."),
        days: z.number().int().positive().max(90).optional().describe("Look-back window in days. Default 7, max 90."),
      },
      annotations: {
        title: "Recent repo activity",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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

  server.registerTool(
    "github_get_commit",
    {
      title: "Get commit",
      description: `Fetch full commit metadata including the file change summary.

Prerequisites: sha typically from github_recent_activity.
Returns: { sha, author, committer, message, committed_at, html_url, files: [{ filename, status, additions, deletions, changes, patch? }] }.
Errors: 'Commit not found' if sha doesn't exist in repo. "Failed to get commit: <gh error>" for API failures.`,
      inputSchema: {
        owner: z.string().describe("Repository owner login."),
        repo: z.string().describe("Repository name without owner."),
        sha: z.string().describe("Full or abbreviated commit SHA, e.g. 'a1b2c3d' or '<40-char-sha>'."),
      },
      annotations: {
        title: "Get commit",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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

  server.registerTool(
    "github_get_pr",
    {
      title: "Get pull request",
      description: `Fetch a single pull request with body, status, reviewers, and merge state.

Prerequisites: number typically from github_recent_activity.
Returns: { number, title, body, state ('open' | 'closed'), merged, author, created_at, updated_at, head, base, html_url, ... }.
Errors: 'Pull request not found' if number doesn't exist. "Failed to get PR: <gh error>" for API failures.`,
      inputSchema: {
        owner: z.string().describe("Repository owner login."),
        repo: z.string().describe("Repository name without owner."),
        number: z.number().int().positive().describe("Pull request number, e.g. 1234."),
      },
      annotations: {
        title: "Get pull request",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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

  server.registerTool(
    "github_list_releases",
    {
      title: "List releases",
      description: `List repo releases ordered by published date DESC.

When to use: build a release-notes digest, find the most recent version, look up release bodies.
Returns: array of { id, tag_name, name, body, published_at, draft, prerelease, html_url }.
Errors: "Failed to list releases: <gh error>" for API failures.`,
      inputSchema: {
        owner: z.string().describe("Repository owner login."),
        repo: z.string().describe("Repository name without owner."),
        limit: z.number().int().positive().max(100).optional().describe("Max results, default 5, max 100."),
      },
      annotations: {
        title: "List releases",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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

let _instance: McpServer | null = null

export function getMcpServer(): McpServer {
  if (!_instance) {
    _instance = createMcpServer()
  }
  return _instance
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
