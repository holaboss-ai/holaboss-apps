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

function upstreamErr(message: string, e: unknown) {
  return errCode("upstream_error", `${message}: ${e instanceof Error ? e.message : String(e)}`)
}

// Output shapes
const CommitFileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
})
const CommitSummarySchema = z.object({
  sha: z.string(),
  message: z.string(),
  author_name: z.string(),
  author_date: z.string(),
  html_url: z.string(),
})
const CommitShape = {
  sha: z.string(),
  message: z.string(),
  author_name: z.string(),
  author_date: z.string(),
  html_url: z.string(),
  stats: z.object({ additions: z.number(), deletions: z.number(), total: z.number() }),
  files: z.array(CommitFileSchema),
}
const PullRequestSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  user: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  html_url: z.string(),
  draft: z.boolean(),
})
const PullRequestShape = {
  number: z.number(),
  title: z.string(),
  state: z.string(),
  body: z.string(),
  user: z.string().nullable(),
  created_at: z.string(),
  merged_at: z.string().nullable(),
  html_url: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changed_files: z.number(),
}
const ReleaseSummarySchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  published_at: z.string().nullable(),
  html_url: z.string(),
  body: z.string(),
})
const RecentActivityShape = {
  commits: z.array(CommitSummarySchema),
  pull_requests: z.array(PullRequestSummarySchema),
  latest_release: ReleaseSummarySchema.nullable(),
  summary: z.string(),
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
Errors: { code: 'upstream_error' } if username is invalid or rate-limited.`,
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
        return upstreamErr("Failed to list repos", e)
      }
    },
  )

  server.registerTool(
    "github_recent_activity",
    {
      title: "Recent repo activity",
      description: `Aggregate recent commits, open PRs, and the latest release for a single repo over a time window.

When to use: "what happened in repo X recently?" — produces a digest for daily/weekly summaries.
When NOT to use: to read a single commit/PR's full body — use github_get_commit / github_get_pr after spotting it here.
Returns: { commits: [...], pull_requests: [...], latest_release: { tag_name, ... } | null, summary }.
Errors: { code: 'upstream_error' } on API failures.`,
      inputSchema: {
        owner: z.string().describe("Repository owner login, e.g. 'anthropics' or 'torvalds'."),
        repo: z.string().describe("Repository name without owner, e.g. 'claude-code' or 'linux'."),
        days: z.number().int().positive().max(90).optional().describe("Look-back window in days. Default 7, max 90."),
      },
      outputSchema: RecentActivityShape,
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
        return success(activity as unknown as Record<string, unknown>)
      } catch (e) {
        return upstreamErr("Failed to get activity", e)
      }
    },
  )

  server.registerTool(
    "github_get_commit",
    {
      title: "Get commit",
      description: `Fetch full commit metadata including the file change summary.

Prerequisites: sha typically from github_recent_activity.
Returns: { sha, message, author_name, author_date, html_url, stats: {additions, deletions, total}, files: [{filename, status, additions, deletions}] }. files is capped at 20.
Errors: { code: 'not_found' } if sha doesn't exist; { code: 'upstream_error' } on API failures.`,
      inputSchema: {
        owner: z.string().describe("Repository owner login."),
        repo: z.string().describe("Repository name without owner."),
        sha: z.string().describe("Full or abbreviated commit SHA, e.g. 'a1b2c3d' or '<40-char-sha>'."),
      },
      outputSchema: CommitShape,
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
        if (!commit) return errCode("not_found", "Commit not found")
        return success(commit as unknown as Record<string, unknown>)
      } catch (e) {
        return upstreamErr("Failed to get commit", e)
      }
    },
  )

  server.registerTool(
    "github_get_pr",
    {
      title: "Get pull request",
      description: `Fetch a single pull request with body, status, and merge info.

Prerequisites: number typically from github_recent_activity.
Returns: { number, title, state, body, user, created_at, merged_at, html_url, additions, deletions, changed_files }. body is truncated to 2000 chars.
Errors: { code: 'not_found' } if number doesn't exist; { code: 'upstream_error' } on API failures.`,
      inputSchema: {
        owner: z.string().describe("Repository owner login."),
        repo: z.string().describe("Repository name without owner."),
        number: z.number().int().positive().describe("Pull request number, e.g. 1234."),
      },
      outputSchema: PullRequestShape,
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
        if (!pr) return errCode("not_found", "Pull request not found")
        return success(pr as unknown as Record<string, unknown>)
      } catch (e) {
        return upstreamErr("Failed to get PR", e)
      }
    },
  )

  server.registerTool(
    "github_list_releases",
    {
      title: "List releases",
      description: `List repo releases ordered by published date DESC.

When to use: build a release-notes digest, find the most recent version, look up release bodies.
Returns: array of { tag_name, name, published_at, html_url, body }.
Errors: { code: 'upstream_error' } on API failures.`,
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
        return upstreamErr("Failed to list releases", e)
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
