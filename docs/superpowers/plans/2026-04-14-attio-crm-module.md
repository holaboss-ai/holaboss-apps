# Attio Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the `hola-boss-apps/attio/` module — a pure-proxy Attio CRM integration that exposes 14 MCP tools to the workspace agent, backed by a bridge+Composio connection, with a single-table SQLite audit log and an Activity Feed UI.

**Architecture:** Two-process TanStack Start module (web + services). `src/server/attio-client.ts` is the single gateway to `holaboss-bridge.createIntegrationClient("attio")`. Tool implementations are thin call+transform functions wrapped by `wrapTool()`, which appends a row to the `agent_actions` table on every invocation. No business data is stored locally; Attio is the source of truth.

**Tech Stack:** TanStack Start v1, React 19, `better-sqlite3`, `@modelcontextprotocol/sdk`, Zod, Tailwind v4 + OKLch tokens, shadcn/ui, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-04-14-attio-crm-module-design.md`

---

## Pre-Task: Spike (manual, gating)

This is not a code task but a required gate before Task 1.

- [x] **Verify Composio supports Attio end-to-end**
  1. Open Holaboss frontend integrations page, attempt to connect Attio via Composio OAuth
  2. Confirm the OAuth flow completes and a connection binding is created for the workspace
  3. From any existing running module (e.g. `twitter`), run a one-off script:
     ```bash
     pnpm exec tsx -e '
       import { createIntegrationClient } from "./src/server/holaboss-bridge.js";
       const c = createIntegrationClient("attio");
       const r = await c.proxy({ method: "GET", endpoint: "https://api.attio.com/v2/objects" });
       console.log(r.status, JSON.stringify(r.data).slice(0, 500));
     '
     ```
  4. Expected: `status: 200` and a JSON payload listing at least `people`, `companies`, `deals` objects
  5. If the call fails (`404`, `invalid_provider`, etc.), STOP and invoke the fallback path from spec §8.1 (request Composio coverage or add direct OAuth to bridge) before continuing

---

## Task 1: Scaffold `attio/` from `_template/`

**Files:**
- Create: `hola-boss-apps/attio/` (copied from `_template/`)
- Modify: `hola-boss-apps/attio/package.json`, `app.runtime.yaml`, `docker-compose.yml`, `README.md`

- [x] **Step 1: Copy template**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps
cp -R _template attio
rm -rf attio/node_modules attio/pnpm-lock.yaml attio/dist attio/.output attio/data
```

- [x] **Step 2: Rename identifiers in `package.json`**

Edit `hola-boss-apps/attio/package.json`, change the `name` field only:
```json
{
  "name": "attio-module",
  ...
}
```

- [x] **Step 3: Rename identifiers in `app.runtime.yaml`**

Overwrite `hola-boss-apps/attio/app.runtime.yaml`:

```yaml
app_id: "attio"
name: "Attio CRM"
slug: "attio"

lifecycle:
  setup: "rm -rf node_modules && corepack enable && pnpm install --maxsockets 1 && pnpm run build && pnpm prune --prod"
  start: "DB_PATH=./data/attio.db nohup node .output/server/index.mjs > /tmp/attio.log 2>&1 & DB_PATH=./data/attio.db nohup node .output/start-services.cjs > /tmp/attio-services.log 2>&1 &"
  stop: "kill $(lsof -t -i :${PORT:-3000} 2>/dev/null) 2>/dev/null || true; kill $(lsof -t -i :${MCP_PORT:-3099} 2>/dev/null) 2>/dev/null || true"

healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 30

mcp:
  enabled: true
  transport: http-sse
  port: 3099
  path: /mcp
  tools:
    - attio_describe_schema
    - attio_get_connection_status
    - attio_find_people
    - attio_get_person
    - attio_create_person
    - attio_update_person
    - attio_find_companies
    - attio_create_company
    - attio_link_person_to_company
    - attio_add_note
    - attio_create_task
    - attio_list_tasks
    - attio_list_records_in_list
    - attio_add_to_list

integration:
  destination: "attio"
  credential_source: "platform"
  holaboss_user_id_required: true

env_contract:
  - "HOLABOSS_APP_GRANT"
  - "HOLABOSS_INTEGRATION_BROKER_URL"
  - "HOLABOSS_WORKSPACE_ID"
  - "HOLABOSS_USER_ID"
  - "HOLABOSS_FRONTEND_URL"
```

- [x] **Step 4: Update `docker-compose.yml`**

Edit `hola-boss-apps/attio/docker-compose.yml`, replace service and volume names with `attio`:

```yaml
services:
  attio:
    build: .
    container_name: attio-module
    ports:
      - "8080:8080"
      - "3099:3099"
    environment:
      - DB_PATH=/app/data/attio.db
      - PORT=8080
      - MCP_PORT=3099
    volumes:
      - attio-data:/app/data

volumes:
  attio-data:
```

- [x] **Step 5: Install deps + build sanity check**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/attio
pnpm install --maxsockets 1
```

Expected: install completes without error. Do NOT run `pnpm build` yet — template code still references `posts`/`queue` which we remove in Task 2.

- [x] **Step 6: Commit**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/attio
git add .
git commit -m "feat(attio): scaffold module from _template"
```

---

## Task 2: Remove template's posts/queue/publisher code

**Files:**
- Delete: `src/server/queue.ts`, `src/server/publisher.ts`, `src/server/actions.ts`, `src/routes/posts.$postId.tsx`, `test/e2e.test.ts`
- Modify: `src/server/start-services.ts`, `src/server/bootstrap.ts`, `src/server/mcp.ts`, `src/server/db.ts`, `src/lib/types.ts`, `src/routes/index.tsx`

- [x] **Step 1: Delete unused files**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/attio
rm src/server/queue.ts src/server/publisher.ts src/server/actions.ts
rm src/routes/posts.\$postId.tsx
rm test/e2e.test.ts
```

- [x] **Step 2: Strip worker from `start-services.ts`**

Replace `hola-boss-apps/attio/src/server/start-services.ts`:

```typescript
#!/usr/bin/env tsx
import { startMcpServer } from "./mcp.js"

const MCP_PORT = Number(process.env.MCP_PORT ?? 3099)

startMcpServer(MCP_PORT)

console.log("[attio] MCP server started")
```

- [x] **Step 3: Reset `mcp.ts` to an empty shell**

Replace `hola-boss-apps/attio/src/server/mcp.ts` entirely:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer } from "node:http"

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "Attio CRM Module",
    version: "1.0.0",
  })
  // tools registered in later tasks
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
```

- [x] **Step 4: Reset `db.ts` to agent_actions schema only**

Replace `hola-boss-apps/attio/src/server/db.ts` entirely:

```typescript
import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import path from "node:path"

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "attio.db")
  mkdirSync(path.dirname(dbPath), { recursive: true })

  _db = new Database(dbPath)
  _db.pragma("journal_mode = WAL")
  _db.pragma("foreign_keys = ON")
  migrate(_db)
  return _db
}

export function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_actions (
      id              TEXT PRIMARY KEY,
      timestamp       INTEGER NOT NULL,
      tool_name       TEXT NOT NULL,
      args_json       TEXT NOT NULL,
      outcome         TEXT NOT NULL,
      duration_ms     INTEGER NOT NULL,
      attio_object    TEXT,
      attio_record_id TEXT,
      attio_deep_link TEXT,
      result_summary  TEXT,
      error_code      TEXT,
      error_message   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_actions_timestamp ON agent_actions (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_tool ON agent_actions (tool_name, timestamp DESC);
  `)
}

export function closeDb() {
  _db?.close()
  _db = null
}

// Test helper: point the singleton at a different file and reinitialize
export function resetDbForTests(dbPath: string) {
  if (_db) {
    _db.close()
    _db = null
  }
  process.env.DB_PATH = dbPath
}
```

- [x] **Step 5: Reset `bootstrap.ts` to a no-op import**

Replace `hola-boss-apps/attio/src/server/bootstrap.ts`:

```typescript
import { getDb } from "./db"

let bootstrapped = false

export function ensureBootstrapped(): void {
  if (bootstrapped) return
  getDb()
  bootstrapped = true
}
```

- [x] **Step 6: Overwrite `src/routes/index.tsx` with a minimal placeholder**

Replace `hola-boss-apps/attio/src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
  component: AttioHome,
})

function AttioHome() {
  return (
    <main className="min-h-screen bg-background text-foreground p-8">
      <h1 className="text-2xl font-semibold">Attio CRM</h1>
      <p className="text-muted-foreground mt-2">
        Module shell — UI components land in a later task.
      </p>
    </main>
  )
}
```

- [x] **Step 7: Typecheck to confirm nothing else references the removed files**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/attio
pnpm run typecheck
```

Expected: clean exit. If any file still imports `queue`, `publisher`, or `PostRecord`, fix the import by deleting the reference (these files are not needed for the attio module).

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(attio): remove template posts/queue code, reset shell"
```

---

## Task 3: Define types

**Files:**
- Create (overwrite): `src/lib/types.ts`

- [x] **Step 1: Overwrite `src/lib/types.ts`**

```typescript
export type AttioErrorCode =
  | "not_connected"
  | "rate_limited"
  | "validation_failed"
  | "upstream_error"

export interface AttioError {
  code: AttioErrorCode
  message: string
  retry_after?: number
}

export type Result<T, E = AttioError> =
  | { ok: true; data: T }
  | { ok: false; error: E }

export interface AttioRecord {
  id: string
  values: Record<string, unknown>
}

export interface AgentActionRecord {
  id: string
  timestamp: number
  tool_name: string
  args_json: string
  outcome: "success" | "error"
  duration_ms: number
  attio_object: string | null
  attio_record_id: string | null
  attio_deep_link: string | null
  result_summary: string | null
  error_code: string | null
  error_message: string | null
}

export interface ToolSuccessMeta {
  attio_object?: string
  attio_record_id?: string
  attio_deep_link?: string
  result_summary?: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
  brandColor: string
}

export const MODULE_CONFIG: PlatformConfig = {
  provider: "attio",
  destination: "attio",
  name: "Attio CRM",
  brandColor: "oklch(0.248 0.006 270)",
}
```

- [x] **Step 2: Typecheck**

```bash
pnpm run typecheck
```

Expected: clean.

- [x] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(attio): add core types and error codes"
```

---

## Task 4: Vitest config + test directory layout

**Files:**
- Create: `vitest.config.ts`, `test/unit/.gitkeep`, `test/integration/.gitkeep`, `test/fixtures/.gitkeep`

- [x] **Step 1: Create `vitest.config.ts`**

`hola-boss-apps/attio/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config"
import viteTsConfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [viteTsConfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    pool: "forks",
  },
})
```

- [x] **Step 2: Create empty test directories**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/attio
mkdir -p test/unit test/integration test/fixtures
touch test/unit/.gitkeep test/integration/.gitkeep test/fixtures/.gitkeep
```

- [x] **Step 3: Update `package.json` scripts**

In `hola-boss-apps/attio/package.json`, replace the `test` scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "test:e2e": "vitest run test/e2e.test.ts"
  }
}
```

(Keep the other scripts — `dev`, `build`, `typecheck`, etc. — unchanged.)

- [x] **Step 4: Sanity test**

```bash
pnpm test
```

Expected: exits 0 with "no test files found" — which is fine, directories are empty.

- [x] **Step 5: Commit**

```bash
git add vitest.config.ts test/ package.json
git commit -m "chore(attio): add vitest config and test directory layout"
```

---

## Task 5: Database layer (TDD)

**Files:**
- Test: `test/unit/db.test.ts`
- Already exists: `src/server/db.ts` (from Task 2)

- [x] **Step 1: Write the failing test**

`hola-boss-apps/attio/test/unit/db.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, migrate, resetDbForTests } from "../../src/server/db"

describe("db", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-db-"))
    resetDbForTests(path.join(tmp, "attio.db"))
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("creates agent_actions table with all columns", () => {
    const db = getDb()
    const info = db.prepare("PRAGMA table_info(agent_actions)").all() as { name: string }[]
    const columns = info.map((c) => c.name).sort()
    expect(columns).toEqual(
      [
        "args_json",
        "attio_deep_link",
        "attio_object",
        "attio_record_id",
        "duration_ms",
        "error_code",
        "error_message",
        "id",
        "outcome",
        "result_summary",
        "timestamp",
        "tool_name",
      ].sort(),
    )
  })

  it("creates indexes on timestamp and tool_name", () => {
    const db = getDb()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_actions'")
      .all() as { name: string }[]
    const names = indexes.map((i) => i.name)
    expect(names).toContain("idx_agent_actions_timestamp")
    expect(names).toContain("idx_agent_actions_tool")
  })

  it("migrate is idempotent", () => {
    const db = getDb()
    expect(() => migrate(db)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
  })
})
```

- [x] **Step 2: Run test**

```bash
pnpm test:unit
```

Expected: all 3 tests PASS (implementation already landed in Task 2).

- [x] **Step 3: Commit**

```bash
git add test/unit/db.test.ts
git commit -m "test(attio): cover db migration and schema"
```

---

## Task 6: Audit log (`audit.ts`) with TDD

**Files:**
- Create: `src/server/audit.ts`
- Test: `test/unit/audit.test.ts`

- [x] **Step 1: Write the failing tests**

`hola-boss-apps/attio/test/unit/audit.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { clearActions, listRecentActions, wrapTool } from "../../src/server/audit"
import type { Result, AttioError } from "../../src/lib/types"

describe("audit.wrapTool", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-audit-"))
    resetDbForTests(path.join(tmp, "attio.db"))
    getDb()
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("appends a success row for a successful call", async () => {
    const tool = wrapTool("attio_test_tool", async (args: { foo: string }): Promise<Result<{ attio_record_id: string; result_summary: string }, AttioError>> => {
      return { ok: true, data: { attio_record_id: "rec_123", result_summary: "did a thing" } }
    })

    const result = await tool({ foo: "bar" })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "attio_test_tool",
      outcome: "success",
      attio_record_id: "rec_123",
      result_summary: "did a thing",
      error_code: null,
      error_message: null,
    })
    expect(JSON.parse(rows[0].args_json)).toEqual({ foo: "bar" })
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0)
  })

  it("appends an error row for a failed call", async () => {
    const tool = wrapTool("attio_test_tool", async (): Promise<Result<{ attio_record_id: string }, AttioError>> => {
      return { ok: false, error: { code: "validation_failed", message: "bad field" } }
    })

    const result = await tool({})
    expect(result.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "attio_test_tool",
      outcome: "error",
      error_code: "validation_failed",
      error_message: "bad field",
      attio_record_id: null,
      result_summary: null,
    })
  })

  it("listRecentActions orders by timestamp DESC", async () => {
    const tool = wrapTool("attio_test_tool", async (): Promise<Result<Record<string, never>, AttioError>> => {
      return { ok: true, data: {} }
    })
    await tool({ n: 1 })
    await new Promise((r) => setTimeout(r, 5))
    await tool({ n: 2 })
    await new Promise((r) => setTimeout(r, 5))
    await tool({ n: 3 })

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(3)
    const args = rows.map((r) => JSON.parse(r.args_json).n)
    expect(args).toEqual([3, 2, 1])
  })

  it("clearActions truncates the table", async () => {
    const tool = wrapTool("attio_test_tool", async (): Promise<Result<Record<string, never>, AttioError>> => {
      return { ok: true, data: {} }
    })
    await tool({})
    await tool({})
    expect(listRecentActions({ limit: 10 })).toHaveLength(2)

    const deleted = clearActions()
    expect(deleted).toBe(2)
    expect(listRecentActions({ limit: 10 })).toHaveLength(0)
  })
})
```

- [x] **Step 2: Run test — expect failure**

```bash
pnpm test:unit
```

Expected: FAIL with `Cannot find module '../../src/server/audit'`.

- [x] **Step 3: Implement `src/server/audit.ts`**

`hola-boss-apps/attio/src/server/audit.ts`:

```typescript
import { randomUUID } from "node:crypto"

import { getDb } from "./db"
import type {
  AgentActionRecord,
  AttioError,
  Result,
  ToolSuccessMeta,
} from "../lib/types"

type ToolFn<A, T> = (
  args: A,
) => Promise<Result<T & ToolSuccessMeta, AttioError>>

export function wrapTool<A, T>(
  toolName: string,
  fn: ToolFn<A, T>,
): ToolFn<A, T> {
  return async (args: A) => {
    const start = Date.now()
    let result: Result<T & ToolSuccessMeta, AttioError>
    try {
      result = await fn(args)
    } catch (e) {
      result = {
        ok: false,
        error: {
          code: "upstream_error",
          message: e instanceof Error ? e.message : String(e),
        },
      }
    }
    recordAction(toolName, args, result, Date.now() - start)
    return result
  }
}

function recordAction<A, T>(
  toolName: string,
  args: A,
  result: Result<T & ToolSuccessMeta, AttioError>,
  duration: number,
): void {
  const db = getDb()
  const row: AgentActionRecord = {
    id: randomUUID(),
    timestamp: Date.now(),
    tool_name: toolName,
    args_json: JSON.stringify(args ?? {}),
    outcome: result.ok ? "success" : "error",
    duration_ms: duration,
    attio_object: result.ok ? result.data.attio_object ?? null : null,
    attio_record_id: result.ok ? result.data.attio_record_id ?? null : null,
    attio_deep_link: result.ok ? result.data.attio_deep_link ?? null : null,
    result_summary: result.ok ? result.data.result_summary ?? null : null,
    error_code: result.ok ? null : result.error.code,
    error_message: result.ok ? null : result.error.message,
  }
  db.prepare(`
    INSERT INTO agent_actions (
      id, timestamp, tool_name, args_json, outcome, duration_ms,
      attio_object, attio_record_id, attio_deep_link, result_summary,
      error_code, error_message
    ) VALUES (
      @id, @timestamp, @tool_name, @args_json, @outcome, @duration_ms,
      @attio_object, @attio_record_id, @attio_deep_link, @result_summary,
      @error_code, @error_message
    )
  `).run(row)
}

export function listRecentActions(params: {
  since?: string
  limit?: number
}): AgentActionRecord[] {
  const db = getDb()
  const limit = params.limit ?? 100
  if (params.since) {
    return db
      .prepare(`
        SELECT * FROM agent_actions
        WHERE id > @since
        ORDER BY timestamp DESC
        LIMIT @limit
      `)
      .all({ since: params.since, limit }) as AgentActionRecord[]
  }
  return db
    .prepare(`
      SELECT * FROM agent_actions
      ORDER BY timestamp DESC
      LIMIT @limit
    `)
    .all({ limit }) as AgentActionRecord[]
}

export function clearActions(): number {
  const db = getDb()
  return db.prepare("DELETE FROM agent_actions").run().changes
}
```

- [x] **Step 4: Run tests — expect pass**

```bash
pnpm test:unit
```

Expected: all audit tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/server/audit.ts test/unit/audit.test.ts
git commit -m "feat(attio): add agent_actions audit log with wrapTool HOF"
```

---

## Task 7: Mock bridge fixture

**Files:**
- Create: `test/fixtures/mock-bridge.ts`

- [x] **Step 1: Write the fixture**

`hola-boss-apps/attio/test/fixtures/mock-bridge.ts`:

```typescript
export interface ProxyRequestLike {
  method: string
  endpoint: string
  body?: unknown
}

export interface ProxyResponseLike<T = unknown> {
  data: T | null
  status: number
  headers: Record<string, string>
}

type Responder = (req: ProxyRequestLike) =>
  | ProxyResponseLike
  | Promise<ProxyResponseLike>
  | { throw: Error }

type Rule = {
  method?: string
  matchEndpoint?: (endpoint: string) => boolean
  once: boolean
  consumed: boolean
  respond: Responder
}

export class MockBridge {
  private rules: Rule[] = []
  public calls: ProxyRequestLike[] = []

  reset() {
    this.rules = []
    this.calls = []
  }

  private addRule(rule: Rule) {
    this.rules.push(rule)
    return this
  }

  whenPost(endpointSuffix: string) {
    return this.matcher("POST", (e) => e.endsWith(endpointSuffix))
  }

  whenGet(endpointSuffix: string) {
    return this.matcher("GET", (e) => e.endsWith(endpointSuffix))
  }

  whenPatch(endpointSuffix: string) {
    return this.matcher("PATCH", (e) => e.endsWith(endpointSuffix))
  }

  whenAny() {
    return this.matcher(undefined, () => true)
  }

  private matcher(method: string | undefined, matchEndpoint: (e: string) => boolean) {
    const self = this
    return {
      respond(status: number, data: unknown = {}, headers: Record<string, string> = {}) {
        self.addRule({
          method,
          matchEndpoint,
          once: false,
          consumed: false,
          respond: () => ({ data, status, headers }),
        })
        return self
      },
      respondOnce(status: number, data: unknown = {}, headers: Record<string, string> = {}) {
        self.addRule({
          method,
          matchEndpoint,
          once: true,
          consumed: false,
          respond: () => ({ data, status, headers }),
        })
        return self
      },
      throwOnce(error: Error) {
        self.addRule({
          method,
          matchEndpoint,
          once: true,
          consumed: false,
          respond: () => ({ throw: error }),
        })
        return self
      },
    }
  }

  async proxy<T>(req: ProxyRequestLike): Promise<ProxyResponseLike<T>> {
    this.calls.push(req)
    for (const rule of this.rules) {
      if (rule.consumed) continue
      if (rule.method && rule.method !== req.method) continue
      if (rule.matchEndpoint && !rule.matchEndpoint(req.endpoint)) continue
      if (rule.once) rule.consumed = true
      const out = await rule.respond(req)
      if ("throw" in out) throw out.throw
      return out as ProxyResponseLike<T>
    }
    throw new Error(`mock-bridge: no rule matched ${req.method} ${req.endpoint}`)
  }

  asClient() {
    return { proxy: this.proxy.bind(this) }
  }
}
```

- [x] **Step 2: Commit**

```bash
git add test/fixtures/mock-bridge.ts
git commit -m "test(attio): add scriptable mock bridge fixture"
```

---

## Task 8: `attio-client.ts` — single bridge gateway (TDD)

**Files:**
- Create: `src/server/attio-client.ts`
- Test: `test/unit/attio-client.test.ts`

- [x] **Step 1: Write the failing tests**

`hola-boss-apps/attio/test/unit/attio-client.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest"

import { call, setBridgeClient } from "../../src/server/attio-client"
import { MockBridge } from "../fixtures/mock-bridge"

describe("attio-client.call", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("returns ok for 2xx", async () => {
    bridge.whenGet("/v2/objects").respond(200, { data: [{ slug: "people" }] })
    const r = await call<{ data: Array<{ slug: string }> }>("GET", "/objects")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.data[0].slug).toBe("people")
  })

  it("maps 400 to validation_failed with message from body", async () => {
    bridge.whenPost("/v2/objects/people/records").respond(400, {
      message: "Attribute 'industry' is required",
    })
    const r = await call("POST", "/objects/people/records", { values: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("industry")
    }
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge.whenGet("/v2/objects").respond(429, { error: "slow down" }, { "retry-after": "30" })
    const r = await call("GET", "/objects")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(30)
    }
  })

  it("maps 500 to upstream_error", async () => {
    bridge.whenGet("/v2/objects").respond(503, { error: "boom" })
    const r = await call("GET", "/objects")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps 'not connected' thrown error to not_connected", async () => {
    bridge.whenAny().throwOnce(new Error("No attio integration configured. Connect via Integrations settings."))
    const r = await call("GET", "/objects")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps other thrown errors to upstream_error", async () => {
    bridge.whenAny().throwOnce(new Error("ECONNREFUSED"))
    const r = await call("GET", "/objects")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })
})
```

- [x] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

Expected: FAIL with `Cannot find module '../../src/server/attio-client'`.

- [x] **Step 3: Implement `src/server/attio-client.ts`**

`hola-boss-apps/attio/src/server/attio-client.ts`:

```typescript
import { createIntegrationClient } from "./holaboss-bridge"
import type { AttioError, Result } from "../lib/types"

const ATTIO_BASE = "https://api.attio.com/v2"

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE"

export interface BridgeLike {
  proxy<T = unknown>(req: {
    method: HttpMethod
    endpoint: string
    body?: unknown
  }): Promise<{ data: T | null; status: number; headers: Record<string, string> }>
}

let _client: BridgeLike | null = null

function defaultClient(): BridgeLike {
  return createIntegrationClient("attio") as BridgeLike
}

export function getBridgeClient(): BridgeLike {
  if (!_client) _client = defaultClient()
  return _client
}

export function setBridgeClient(client: BridgeLike | null): void {
  _client = client
}

export function resetBridgeClient(): void {
  _client = null
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"] ?? headers["Retry-After"]
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function isNotConnectedError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message.toLowerCase()
  return (
    msg.includes("no attio integration") ||
    msg.includes("not connected") ||
    msg.includes("connect via integrations")
  )
}

function extractErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as Record<string, unknown>
  if (typeof d.message === "string") return d.message
  if (typeof d.error === "string") return d.error
  if (d.error && typeof d.error === "object") {
    const inner = (d.error as Record<string, unknown>).message
    if (typeof inner === "string") return inner
  }
  return undefined
}

export async function call<T>(
  method: HttpMethod,
  endpoint: string,
  body?: unknown,
): Promise<Result<T, AttioError>> {
  const client = getBridgeClient()
  let resp
  try {
    resp = await client.proxy<T>({
      method,
      endpoint: `${ATTIO_BASE}${endpoint}`,
      body,
    })
  } catch (e) {
    if (isNotConnectedError(e)) {
      return {
        ok: false,
        error: {
          code: "not_connected",
          message: "Attio is not connected for this workspace.",
        },
      }
    }
    return {
      ok: false,
      error: {
        code: "upstream_error",
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }

  if (resp.status >= 200 && resp.status < 300) {
    return { ok: true, data: resp.data as T }
  }
  if (resp.status === 429) {
    return {
      ok: false,
      error: {
        code: "rate_limited",
        message: "Attio API rate limit exceeded.",
        retry_after: parseRetryAfter(resp.headers),
      },
    }
  }
  if (resp.status >= 400 && resp.status < 500) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: extractErrorMessage(resp.data) ?? `Attio returned HTTP ${resp.status}.`,
      },
    }
  }
  return {
    ok: false,
    error: {
      code: "upstream_error",
      message: extractErrorMessage(resp.data) ?? `Attio returned HTTP ${resp.status}.`,
    },
  }
}

export const apiGet = <T>(endpoint: string) => call<T>("GET", endpoint)
export const apiPost = <T>(endpoint: string, body: unknown) => call<T>("POST", endpoint, body)
export const apiPatch = <T>(endpoint: string, body: unknown) => call<T>("PATCH", endpoint, body)
export const apiDelete = <T>(endpoint: string) => call<T>("DELETE", endpoint)
```

- [x] **Step 4: Run — expect pass**

```bash
pnpm test:unit
```

Expected: all 6 attio-client tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/server/attio-client.ts test/unit/attio-client.test.ts
git commit -m "feat(attio): add attio-client bridge gateway with error mapping"
```

---

## Task 9: Query builder helper for `find_*` tools (TDD)

**Files:**
- Create: `src/server/query-builder.ts`
- Test: `test/unit/query-builder.test.ts`

- [x] **Step 1: Write the failing tests**

`hola-boss-apps/attio/test/unit/query-builder.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { buildFuzzyPeopleQuery, buildFuzzyCompaniesQuery } from "../../src/server/query-builder"

describe("buildFuzzyPeopleQuery", () => {
  it("produces a compound OR filter on name and email", () => {
    const body = buildFuzzyPeopleQuery("alice", 20)
    expect(body.limit).toBe(20)
    expect(body.filter).toEqual({
      $or: [
        { name: { $contains: "alice" } },
        { email_addresses: { $contains: "alice" } },
      ],
    })
  })

  it("defaults limit to 20", () => {
    const body = buildFuzzyPeopleQuery("alice")
    expect(body.limit).toBe(20)
  })

  it("trims whitespace from query", () => {
    const body = buildFuzzyPeopleQuery("  alice  ")
    expect(body.filter.$or[0].name.$contains).toBe("alice")
  })
})

describe("buildFuzzyCompaniesQuery", () => {
  it("produces a compound OR filter on name and domain", () => {
    const body = buildFuzzyCompaniesQuery("acme", 10)
    expect(body.limit).toBe(10)
    expect(body.filter).toEqual({
      $or: [
        { name: { $contains: "acme" } },
        { domains: { $contains: "acme" } },
      ],
    })
  })
})
```

- [x] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

Expected: FAIL — module not found.

- [x] **Step 3: Implement `src/server/query-builder.ts`**

```typescript
export interface QueryBody {
  limit: number
  filter: {
    $or: Array<Record<string, { $contains: string }>>
  }
}

export function buildFuzzyPeopleQuery(query: string, limit = 20): QueryBody {
  const q = query.trim()
  return {
    limit,
    filter: {
      $or: [
        { name: { $contains: q } },
        { email_addresses: { $contains: q } },
      ],
    },
  }
}

export function buildFuzzyCompaniesQuery(query: string, limit = 20): QueryBody {
  const q = query.trim()
  return {
    limit,
    filter: {
      $or: [
        { name: { $contains: q } },
        { domains: { $contains: q } },
      ],
    },
  }
}
```

- [x] **Step 4: Run — expect pass**

```bash
pnpm test:unit
```

- [x] **Step 5: Commit**

```bash
git add src/server/query-builder.ts test/unit/query-builder.test.ts
git commit -m "feat(attio): add fuzzy query builder for people and companies"
```

---

## Task 10: Tools module scaffold + schema & connection tools (TDD)

**Files:**
- Create: `src/server/tools.ts`
- Test: `test/unit/tools-schema.test.ts`
- Modify: `src/server/mcp.ts`

`src/server/tools.ts` will export one function per tool (pre-wrap), plus a `registerTools(server)` function that wires them into the MCP server with zod schemas. Tools are implemented incrementally — Task 10 adds the 2 schema/connection tools, Tasks 11-14 add People/Companies/Notes/Tasks/Lists.

- [x] **Step 1: Write the failing tests**

`hola-boss-apps/attio/test/unit/tools-schema.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  closeDb,
  getDb,
  resetDbForTests,
} from "../../src/server/db"
import { setBridgeClient } from "../../src/server/attio-client"
import { describeSchemaImpl, getConnectionStatusImpl } from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("schema tools", () => {
  let bridge: MockBridge
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-tools-"))
    resetDbForTests(path.join(tmp, "attio.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("describe_schema returns objects with attributes", async () => {
    bridge.whenGet("/v2/objects/people/attributes").respond(200, {
      data: [{ api_slug: "name", title: "Name", type: "personal-name", is_required: true, is_unique: false }],
    })
    bridge.whenGet("/v2/objects/companies/attributes").respond(200, {
      data: [{ api_slug: "name", title: "Name", type: "text", is_required: true, is_unique: false }],
    })
    bridge.whenGet("/v2/objects/deals/attributes").respond(200, {
      data: [{ api_slug: "name", title: "Name", type: "text", is_required: true, is_unique: false }],
    })

    const r = await describeSchemaImpl({ objects: ["people", "companies", "deals"] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.objects).toHaveLength(3)
      expect(r.data.objects[0].slug).toBe("people")
      expect(r.data.objects[0].attributes[0].slug).toBe("name")
    }
  })

  it("get_connection_status returns connected true when bridge succeeds", async () => {
    bridge.whenGet("/v2/self").respond(200, { data: { workspace_name: "Acme Workspace" } })
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.connected).toBe(true)
      expect(r.data.workspace_name).toBe("Acme Workspace")
    }
  })

  it("get_connection_status returns connected false on not_connected error", async () => {
    bridge.whenGet("/v2/self").throwOnce(new Error("No attio integration configured"))
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.connected).toBe(false)
  })
})

// import needed for beforeEach scoping
import { afterEach } from "vitest"
```

- [x] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

- [x] **Step 3: Implement `src/server/tools.ts`**

`hola-boss-apps/attio/src/server/tools.ts`:

```typescript
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { apiGet, apiPost, apiPatch } from "./attio-client"
import { wrapTool } from "./audit"
import { buildFuzzyPeopleQuery, buildFuzzyCompaniesQuery } from "./query-builder"
import type { AttioError, Result, ToolSuccessMeta } from "../lib/types"

const ATTIO_APP_BASE = "https://app.attio.com"

function personDeepLink(id: string) {
  return `${ATTIO_APP_BASE}/records/people/${id}`
}
function companyDeepLink(id: string) {
  return `${ATTIO_APP_BASE}/records/companies/${id}`
}
function dealDeepLink(id: string) {
  return `${ATTIO_APP_BASE}/records/deals/${id}`
}
function deepLinkFor(parent: "people" | "companies" | "deals", id: string) {
  if (parent === "people") return personDeepLink(id)
  if (parent === "companies") return companyDeepLink(id)
  return dealDeepLink(id)
}

// -------------------- Schema & Connection --------------------

export interface DescribeSchemaInput {
  objects?: string[]
}
export interface SchemaAttribute {
  slug: string
  title: string
  type: string
  is_required: boolean
  is_unique: boolean
  options?: unknown
}
export interface SchemaObject {
  slug: string
  plural_name: string
  attributes: SchemaAttribute[]
}

export async function describeSchemaImpl(
  input: DescribeSchemaInput,
): Promise<Result<{ objects: SchemaObject[] } & ToolSuccessMeta, AttioError>> {
  const slugs = input.objects ?? ["people", "companies", "deals"]
  const objects: SchemaObject[] = []
  for (const slug of slugs) {
    const r = await apiGet<{ data: Array<Record<string, unknown>> }>(`/objects/${slug}/attributes`)
    if (!r.ok) return r
    const attrs: SchemaAttribute[] = (r.data.data ?? []).map((a) => ({
      slug: String(a.api_slug ?? a.slug ?? ""),
      title: String(a.title ?? ""),
      type: String(a.type ?? ""),
      is_required: Boolean(a.is_required),
      is_unique: Boolean(a.is_unique),
      options: a.config ?? a.options ?? undefined,
    }))
    objects.push({ slug, plural_name: slug, attributes: attrs })
  }
  return { ok: true, data: { objects, result_summary: `Described ${objects.length} Attio object(s)` } }
}

export async function getConnectionStatusImpl(
  _input: Record<string, never>,
): Promise<Result<{ connected: boolean; workspace_name?: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiGet<{ data: { workspace_name?: string } }>("/self")
  if (r.ok) {
    return {
      ok: true,
      data: {
        connected: true,
        workspace_name: r.data.data?.workspace_name,
        result_summary: "Connection verified",
      },
    }
  }
  if (r.error.code === "not_connected") {
    return { ok: true, data: { connected: false, result_summary: "Not connected" } }
  }
  return r as unknown as Result<{ connected: boolean } & ToolSuccessMeta, AttioError>
}

// -------------------- MCP registration --------------------

export function registerTools(server: McpServer): void {
  const describeSchema = wrapTool("attio_describe_schema", describeSchemaImpl)
  const getConnectionStatus = wrapTool("attio_get_connection_status", getConnectionStatusImpl)

  server.tool(
    "attio_describe_schema",
    "Describe Attio workspace schema — returns objects and their attributes (including custom ones). Call this before creating or updating records to learn the available fields. Defaults to [people, companies, deals]; pass objects to explore others.",
    {
      objects: z.array(z.string()).optional().describe("Object slugs to describe, e.g. ['people','companies','deals']"),
    },
    async ({ objects }) => {
      const r = await describeSchema({ objects })
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] }
    },
  )

  server.tool(
    "attio_get_connection_status",
    "Check whether Attio is connected for this workspace. Returns { connected, workspace_name }. If not connected, tell the user to connect Attio from the Holaboss integrations page.",
    {},
    async () => {
      const r = await getConnectionStatus({})
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] }
    },
  )
}
```

- [x] **Step 4: Wire `registerTools` into `mcp.ts`**

Edit `hola-boss-apps/attio/src/server/mcp.ts`: import and call `registerTools`:

```typescript
import { registerTools } from "./tools"
// ...
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "Attio CRM Module",
    version: "1.0.0",
  })
  registerTools(server)
  return server
}
```

- [x] **Step 5: Run — expect pass**

```bash
pnpm test:unit
```

- [x] **Step 6: Commit**

```bash
git add src/server/tools.ts src/server/mcp.ts test/unit/tools-schema.test.ts
git commit -m "feat(attio): add describe_schema and get_connection_status tools"
```

---

## Task 11: People tools (4) with TDD

**Files:**
- Modify: `src/server/tools.ts`
- Test: `test/unit/tools-people.test.ts`

- [x] **Step 1: Write the failing tests**

`hola-boss-apps/attio/test/unit/tools-people.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { setBridgeClient } from "../../src/server/attio-client"
import {
  findPeopleImpl,
  getPersonImpl,
  createPersonImpl,
  updatePersonImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("people tools", () => {
  let bridge: MockBridge
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-people-"))
    resetDbForTests(path.join(tmp, "attio.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("find_people posts to records/query and returns records", async () => {
    bridge.whenPost("/v2/objects/people/records/query").respond(200, {
      data: [
        { id: { record_id: "rec_1" }, values: { name: [{ full_name: "Alice" }] } },
      ],
    })
    const r = await findPeopleImpl({ query: "alice", limit: 10 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.records).toHaveLength(1)
      expect(r.data.records[0].id).toBe("rec_1")
    }
  })

  it("get_person fetches by record_id", async () => {
    bridge.whenGet("/v2/objects/people/records/rec_abc").respond(200, {
      data: { id: { record_id: "rec_abc" }, values: { name: [{ full_name: "Bob" }] } },
    })
    const r = await getPersonImpl({ record_id: "rec_abc" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.record.id).toBe("rec_abc")
  })

  it("create_person posts attributes and returns record_id", async () => {
    bridge.whenPost("/v2/objects/people/records").respond(200, {
      data: { id: { record_id: "rec_new" } },
    })
    const r = await createPersonImpl({ attributes: { name: "Alice", email_addresses: ["a@b.com"] } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.record_id).toBe("rec_new")
      expect(r.data.record_url).toContain("/people/rec_new")
    }
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.body).toEqual({ data: { values: { name: "Alice", email_addresses: ["a@b.com"] } } })
  })

  it("update_person uses PATCH", async () => {
    bridge.whenPatch("/v2/objects/people/records/rec_abc").respond(200, {
      data: { id: { record_id: "rec_abc" } },
    })
    const r = await updatePersonImpl({ record_id: "rec_abc", attributes: { job_title: "CEO" } })
    expect(r.ok).toBe(true)
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.method).toBe("PATCH")
    expect(lastCall.body).toEqual({ data: { values: { job_title: "CEO" } } })
  })

  it("create_person propagates validation_failed", async () => {
    bridge.whenPost("/v2/objects/people/records").respond(422, {
      message: "Attribute 'email_addresses' must be unique",
    })
    const r = await createPersonImpl({ attributes: { email_addresses: ["dup@x.com"] } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("unique")
    }
  })
})
```

- [x] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

Expected: FAIL — named imports don't exist yet.

- [x] **Step 3: Add people implementations + registrations to `src/server/tools.ts`**

Append to `hola-boss-apps/attio/src/server/tools.ts` (above `registerTools`):

```typescript
import type { AttioRecord } from "../lib/types"

function normalizeRecord(raw: Record<string, unknown>): AttioRecord {
  const id = raw.id && typeof raw.id === "object" && "record_id" in (raw.id as Record<string, unknown>)
    ? String((raw.id as Record<string, unknown>).record_id)
    : String(raw.id ?? "")
  return { id, values: (raw.values as Record<string, unknown>) ?? {} }
}

// -------------------- People --------------------

export interface FindPeopleInput { query: string; limit?: number }
export async function findPeopleImpl(
  input: FindPeopleInput,
): Promise<Result<{ records: AttioRecord[] } & ToolSuccessMeta, AttioError>> {
  const body = buildFuzzyPeopleQuery(input.query, input.limit ?? 20)
  const r = await apiPost<{ data: Array<Record<string, unknown>> }>("/objects/people/records/query", body)
  if (!r.ok) return r
  const records = (r.data.data ?? []).map(normalizeRecord)
  return {
    ok: true,
    data: {
      records,
      attio_object: "people",
      result_summary: `Found ${records.length} people matching "${input.query}"`,
    },
  }
}

export interface GetPersonInput { record_id: string }
export async function getPersonImpl(
  input: GetPersonInput,
): Promise<Result<{ record: AttioRecord } & ToolSuccessMeta, AttioError>> {
  const r = await apiGet<{ data: Record<string, unknown> }>(`/objects/people/records/${input.record_id}`)
  if (!r.ok) return r
  const record = normalizeRecord(r.data.data ?? {})
  return {
    ok: true,
    data: {
      record,
      attio_object: "people",
      attio_record_id: record.id,
      attio_deep_link: personDeepLink(record.id),
      result_summary: `Fetched person ${record.id}`,
    },
  }
}

export interface CreatePersonInput { attributes: Record<string, unknown> }
export async function createPersonImpl(
  input: CreatePersonInput,
): Promise<Result<{ record_id: string; record_url: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>("/objects/people/records", {
    data: { values: input.attributes },
  })
  if (!r.ok) return r
  const record = normalizeRecord(r.data.data ?? {})
  return {
    ok: true,
    data: {
      record_id: record.id,
      record_url: personDeepLink(record.id),
      attio_object: "people",
      attio_record_id: record.id,
      attio_deep_link: personDeepLink(record.id),
      result_summary: `Created person ${record.id}`,
    },
  }
}

export interface UpdatePersonInput { record_id: string; attributes: Record<string, unknown> }
export async function updatePersonImpl(
  input: UpdatePersonInput,
): Promise<Result<{ record_id: string; record_url: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiPatch<{ data: Record<string, unknown> }>(
    `/objects/people/records/${input.record_id}`,
    { data: { values: input.attributes } },
  )
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      record_id: input.record_id,
      record_url: personDeepLink(input.record_id),
      attio_object: "people",
      attio_record_id: input.record_id,
      attio_deep_link: personDeepLink(input.record_id),
      result_summary: `Updated person ${input.record_id}`,
    },
  }
}
```

Then extend `registerTools` with 4 new `server.tool(...)` calls:

```typescript
  const findPeople = wrapTool("attio_find_people", findPeopleImpl)
  const getPerson = wrapTool("attio_get_person", getPersonImpl)
  const createPerson = wrapTool("attio_create_person", createPersonImpl)
  const updatePerson = wrapTool("attio_update_person", updatePersonImpl)

  server.tool(
    "attio_find_people",
    "Search for people in Attio by name or email (fuzzy contains match). Returns up to limit records. Use this before creating a person to avoid duplicates.",
    {
      query: z.string().describe("Name fragment or email substring to search for"),
      limit: z.number().int().positive().max(100).optional().describe("Max results, default 20"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await findPeople(args)) }] }),
  )

  server.tool(
    "attio_get_person",
    "Fetch a single Attio person by record_id, returning all attribute values.",
    {
      record_id: z.string().describe("Attio person record id"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getPerson(args)) }] }),
  )

  server.tool(
    "attio_create_person",
    "Create a new person in Attio. Pass attributes as a map of {attribute_slug: value}. Call attio_describe_schema first to learn the available attributes (including custom ones). Attio validates fields on the server — 4xx errors come back as validation_failed with a message explaining what's wrong.",
    {
      attributes: z.record(z.unknown()).describe("Map of attribute_slug → value, e.g. { name: 'Alice', email_addresses: ['a@b.com'] }"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createPerson(args)) }] }),
  )

  server.tool(
    "attio_update_person",
    "Patch an existing Attio person. Only the supplied attributes are modified; omitted fields remain unchanged.",
    {
      record_id: z.string().describe("Attio person record id"),
      attributes: z.record(z.unknown()).describe("Map of attribute_slug → new value"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await updatePerson(args)) }] }),
  )
```

- [x] **Step 4: Run — expect pass**

```bash
pnpm test:unit
```

- [x] **Step 5: Commit**

```bash
git add src/server/tools.ts test/unit/tools-people.test.ts
git commit -m "feat(attio): add find/get/create/update_person tools"
```

---

## Task 12: Companies tools (3) with TDD

**Files:**
- Modify: `src/server/tools.ts`
- Test: `test/unit/tools-companies.test.ts`

- [x] **Step 1: Write the failing tests**

`hola-boss-apps/attio/test/unit/tools-companies.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { setBridgeClient } from "../../src/server/attio-client"
import {
  findCompaniesImpl,
  createCompanyImpl,
  linkPersonToCompanyImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("companies tools", () => {
  let bridge: MockBridge
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-companies-"))
    resetDbForTests(path.join(tmp, "attio.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("find_companies uses domain filter", async () => {
    bridge.whenPost("/v2/objects/companies/records/query").respond(200, {
      data: [{ id: { record_id: "co_1" }, values: {} }],
    })
    const r = await findCompaniesImpl({ query: "acme", limit: 5 })
    expect(r.ok).toBe(true)
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.body).toMatchObject({ limit: 5 })
  })

  it("create_company returns deep link", async () => {
    bridge.whenPost("/v2/objects/companies/records").respond(200, {
      data: { id: { record_id: "co_new" } },
    })
    const r = await createCompanyImpl({ attributes: { name: "Acme", domains: ["acme.com"] } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.record_url).toContain("/companies/co_new")
  })

  it("link_person_to_company patches person's company reference", async () => {
    bridge.whenPatch("/v2/objects/people/records/rec_1").respond(200, { data: { id: { record_id: "rec_1" } } })
    const r = await linkPersonToCompanyImpl({ person_id: "rec_1", company_id: "co_1" })
    expect(r.ok).toBe(true)
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.method).toBe("PATCH")
    expect(lastCall.body).toEqual({
      data: { values: { company: [{ target_object: "companies", target_record_id: "co_1" }] } },
    })
  })
})
```

- [x] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

- [x] **Step 3: Add impls + registrations**

Append to `hola-boss-apps/attio/src/server/tools.ts`:

```typescript
// -------------------- Companies --------------------

export interface FindCompaniesInput { query: string; limit?: number }
export async function findCompaniesImpl(
  input: FindCompaniesInput,
): Promise<Result<{ records: AttioRecord[] } & ToolSuccessMeta, AttioError>> {
  const body = buildFuzzyCompaniesQuery(input.query, input.limit ?? 20)
  const r = await apiPost<{ data: Array<Record<string, unknown>> }>("/objects/companies/records/query", body)
  if (!r.ok) return r
  const records = (r.data.data ?? []).map(normalizeRecord)
  return {
    ok: true,
    data: {
      records,
      attio_object: "companies",
      result_summary: `Found ${records.length} companies matching "${input.query}"`,
    },
  }
}

export interface CreateCompanyInput { attributes: Record<string, unknown> }
export async function createCompanyImpl(
  input: CreateCompanyInput,
): Promise<Result<{ record_id: string; record_url: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>("/objects/companies/records", {
    data: { values: input.attributes },
  })
  if (!r.ok) return r
  const record = normalizeRecord(r.data.data ?? {})
  return {
    ok: true,
    data: {
      record_id: record.id,
      record_url: companyDeepLink(record.id),
      attio_object: "companies",
      attio_record_id: record.id,
      attio_deep_link: companyDeepLink(record.id),
      result_summary: `Created company ${record.id}`,
    },
  }
}

export interface LinkPersonToCompanyInput { person_id: string; company_id: string }
export async function linkPersonToCompanyImpl(
  input: LinkPersonToCompanyInput,
): Promise<Result<{ ok: true } & ToolSuccessMeta, AttioError>> {
  const r = await apiPatch<{ data: Record<string, unknown> }>(
    `/objects/people/records/${input.person_id}`,
    {
      data: {
        values: {
          company: [{ target_object: "companies", target_record_id: input.company_id }],
        },
      },
    },
  )
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      ok: true,
      attio_object: "people",
      attio_record_id: input.person_id,
      attio_deep_link: personDeepLink(input.person_id),
      result_summary: `Linked person ${input.person_id} to company ${input.company_id}`,
    },
  }
}
```

Extend `registerTools` with:

```typescript
  const findCompanies = wrapTool("attio_find_companies", findCompaniesImpl)
  const createCompany = wrapTool("attio_create_company", createCompanyImpl)
  const linkPersonToCompany = wrapTool("attio_link_person_to_company", linkPersonToCompanyImpl)

  server.tool(
    "attio_find_companies",
    "Search for companies in Attio by name or domain. Returns up to limit records.",
    {
      query: z.string().describe("Name fragment or domain substring"),
      limit: z.number().int().positive().max(100).optional().describe("Max results, default 20"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await findCompanies(args)) }] }),
  )

  server.tool(
    "attio_create_company",
    "Create a new company in Attio. Pass attributes as a map of {attribute_slug: value}. Call attio_describe_schema first to learn the workspace's fields.",
    {
      attributes: z.record(z.unknown()).describe("Map of attribute_slug → value, e.g. { name: 'Acme', domains: ['acme.com'] }"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createCompany(args)) }] }),
  )

  server.tool(
    "attio_link_person_to_company",
    "Attach an existing person to an existing company by setting the person's 'company' reference attribute. Use this after creating or finding both records.",
    {
      person_id: z.string().describe("Attio person record id"),
      company_id: z.string().describe("Attio company record id"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await linkPersonToCompany(args)) }] }),
  )
```

- [x] **Step 4: Run — expect pass**

```bash
pnpm test:unit
```

- [x] **Step 5: Commit**

```bash
git add src/server/tools.ts test/unit/tools-companies.test.ts
git commit -m "feat(attio): add find/create_company and link_person_to_company tools"
```

---

## Task 13: Notes + Tasks tools (3) with TDD

**Files:**
- Modify: `src/server/tools.ts`
- Test: `test/unit/tools-notes-tasks.test.ts`

- [x] **Step 1: Write the failing tests**

`hola-boss-apps/attio/test/unit/tools-notes-tasks.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { setBridgeClient } from "../../src/server/attio-client"
import {
  addNoteImpl,
  createTaskImpl,
  listTasksImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("notes and tasks tools", () => {
  let bridge: MockBridge
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-notes-"))
    resetDbForTests(path.join(tmp, "attio.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("add_note posts to notes endpoint with parent reference", async () => {
    bridge.whenPost("/v2/notes").respond(200, { data: { id: { note_id: "note_1" } } })
    const r = await addNoteImpl({
      parent_object: "people",
      parent_record_id: "rec_1",
      title: "First call",
      content: "Went well",
    })
    expect(r.ok).toBe(true)
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.body).toEqual({
      data: {
        parent_object: "people",
        parent_record_id: "rec_1",
        title: "First call",
        content: "Went well",
        format: "plaintext",
      },
    })
  })

  it("create_task posts with linked records", async () => {
    bridge.whenPost("/v2/tasks").respond(200, { data: { id: { task_id: "task_1" } } })
    const r = await createTaskImpl({
      content: "Follow up with Alice",
      deadline_at: "2026-04-20T10:00:00Z",
      linked_records: [{ object: "people", record_id: "rec_1" }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.task_id).toBe("task_1")
  })

  it("list_tasks passes filter query params", async () => {
    bridge.whenGet("/v2/tasks").respond(200, {
      data: [
        { id: { task_id: "t1" }, content: "ping", deadline_at: null, is_completed: false, linked_records: [] },
      ],
    })
    const r = await listTasksImpl({ filter: { status: "open" }, limit: 20 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.tasks).toHaveLength(1)
  })
})
```

- [x] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

- [x] **Step 3: Add impls + registrations in `src/server/tools.ts`**

Append:

```typescript
// -------------------- Notes --------------------

export interface AddNoteInput {
  parent_object: "people" | "companies" | "deals"
  parent_record_id: string
  title: string
  content: string
}
export async function addNoteImpl(
  input: AddNoteInput,
): Promise<Result<{ note_id: string; note_url: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>("/notes", {
    data: {
      parent_object: input.parent_object,
      parent_record_id: input.parent_record_id,
      title: input.title,
      content: input.content,
      format: "plaintext",
    },
  })
  if (!r.ok) return r
  const raw = r.data.data ?? {}
  const id = raw.id && typeof raw.id === "object" && "note_id" in (raw.id as Record<string, unknown>)
    ? String((raw.id as Record<string, unknown>).note_id)
    : String(raw.id ?? "")
  const parentLink = deepLinkFor(input.parent_object, input.parent_record_id)
  return {
    ok: true,
    data: {
      note_id: id,
      note_url: parentLink,
      attio_object: input.parent_object,
      attio_record_id: input.parent_record_id,
      attio_deep_link: parentLink,
      result_summary: `Added note "${input.title}" to ${input.parent_object}/${input.parent_record_id}`,
    },
  }
}

// -------------------- Tasks --------------------

export interface CreateTaskInput {
  content: string
  deadline_at?: string
  assignee?: string
  linked_records?: Array<{ object: string; record_id: string }>
}
export async function createTaskImpl(
  input: CreateTaskInput,
): Promise<Result<{ task_id: string } & ToolSuccessMeta, AttioError>> {
  const body = {
    data: {
      content: input.content,
      format: "plaintext",
      deadline_at: input.deadline_at ?? null,
      assignees: input.assignee ? [{ referenced_actor_type: "workspace-member", referenced_actor_id: input.assignee }] : [],
      linked_records: (input.linked_records ?? []).map((l) => ({
        target_object: l.object,
        target_record_id: l.record_id,
      })),
    },
  }
  const r = await apiPost<{ data: Record<string, unknown> }>("/tasks", body)
  if (!r.ok) return r
  const raw = r.data.data ?? {}
  const id = raw.id && typeof raw.id === "object" && "task_id" in (raw.id as Record<string, unknown>)
    ? String((raw.id as Record<string, unknown>).task_id)
    : String(raw.id ?? "")
  return {
    ok: true,
    data: {
      task_id: id,
      result_summary: `Created task "${input.content.slice(0, 40)}"`,
    },
  }
}

export interface ListTasksInput {
  filter?: {
    assignee?: string
    status?: "open" | "completed"
    linked_record?: { object: string; record_id: string }
  }
  limit?: number
}
export interface TaskSummary {
  id: string
  content: string
  deadline_at: string | null
  is_completed: boolean
  linked_records: Array<{ object: string; record_id: string }>
}
export async function listTasksImpl(
  input: ListTasksInput,
): Promise<Result<{ tasks: TaskSummary[] } & ToolSuccessMeta, AttioError>> {
  const params = new URLSearchParams()
  params.set("limit", String(input.limit ?? 50))
  if (input.filter?.status === "completed") params.set("is_completed", "true")
  if (input.filter?.status === "open") params.set("is_completed", "false")
  if (input.filter?.assignee) params.set("assignee", input.filter.assignee)
  if (input.filter?.linked_record) {
    params.set("linked_object", input.filter.linked_record.object)
    params.set("linked_record_id", input.filter.linked_record.record_id)
  }
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>(`/tasks?${params.toString()}`)
  if (!r.ok) return r
  const tasks: TaskSummary[] = (r.data.data ?? []).map((t) => ({
    id: t.id && typeof t.id === "object" && "task_id" in (t.id as Record<string, unknown>)
      ? String((t.id as Record<string, unknown>).task_id)
      : String(t.id ?? ""),
    content: String(t.content ?? ""),
    deadline_at: (t.deadline_at as string | null) ?? null,
    is_completed: Boolean(t.is_completed),
    linked_records: Array.isArray(t.linked_records)
      ? (t.linked_records as Array<Record<string, unknown>>).map((l) => ({
          object: String(l.target_object ?? l.object ?? ""),
          record_id: String(l.target_record_id ?? l.record_id ?? ""),
        }))
      : [],
  }))
  return { ok: true, data: { tasks, result_summary: `Listed ${tasks.length} task(s)` } }
}
```

Extend `registerTools`:

```typescript
  const addNote = wrapTool("attio_add_note", addNoteImpl)
  const createTask = wrapTool("attio_create_task", createTaskImpl)
  const listTasks = wrapTool("attio_list_tasks", listTasksImpl)

  server.tool(
    "attio_add_note",
    "Attach a plaintext note to an Attio record (person, company, or deal). Use parent_object='people' for a person, 'companies' for a company, 'deals' for a deal. The note will appear in the record's timeline in Attio's UI.",
    {
      parent_object: z.enum(["people", "companies", "deals"]).describe("The type of record to attach the note to"),
      parent_record_id: z.string().describe("The record id to attach the note to"),
      title: z.string().describe("Note title"),
      content: z.string().describe("Note body (plaintext)"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await addNote(args)) }] }),
  )

  server.tool(
    "attio_create_task",
    "Create an Attio task (to-do). deadline_at must be an ISO 8601 string with an explicit timezone offset, e.g. '2026-04-20T10:00:00Z' or '2026-04-20T10:00:00-05:00'. linked_records attaches the task to one or more records.",
    {
      content: z.string().describe("Task description"),
      deadline_at: z.string().optional().describe("ISO 8601 deadline with timezone, e.g. '2026-04-20T10:00:00Z'"),
      assignee: z.string().optional().describe("Workspace member id to assign"),
      linked_records: z
        .array(z.object({ object: z.string(), record_id: z.string() }))
        .optional()
        .describe("Records to link this task to, e.g. [{ object: 'people', record_id: 'rec_1' }]"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createTask(args)) }] }),
  )

  server.tool(
    "attio_list_tasks",
    "List Attio tasks, optionally filtered by assignee, status (open/completed), or a linked record.",
    {
      filter: z
        .object({
          assignee: z.string().optional(),
          status: z.enum(["open", "completed"]).optional(),
          linked_record: z.object({ object: z.string(), record_id: z.string() }).optional(),
        })
        .optional(),
      limit: z.number().int().positive().max(200).optional().describe("Max results, default 50"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await listTasks(args)) }] }),
  )
```

- [x] **Step 4: Run — expect pass**

```bash
pnpm test:unit
```

- [x] **Step 5: Commit**

```bash
git add src/server/tools.ts test/unit/tools-notes-tasks.test.ts
git commit -m "feat(attio): add add_note, create_task, list_tasks tools"
```

---

## Task 14: Lists tools (2) with TDD

**Files:**
- Modify: `src/server/tools.ts`
- Test: `test/unit/tools-lists.test.ts`

- [x] **Step 1: Write the failing tests**

`hola-boss-apps/attio/test/unit/tools-lists.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { setBridgeClient } from "../../src/server/attio-client"
import {
  listRecordsInListImpl,
  addToListImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("lists tools", () => {
  let bridge: MockBridge
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-lists-"))
    resetDbForTests(path.join(tmp, "attio.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("list_records_in_list queries entries and maps them", async () => {
    bridge.whenPost("/v2/lists/list_abc/entries/query").respond(200, {
      data: [
        {
          id: { entry_id: "entry_1" },
          parent_object: "people",
          parent_record_id: "rec_1",
          entry_values: { stage: [{ option: { title: "Discovery" } }] },
        },
      ],
    })
    const r = await listRecordsInListImpl({ list_id: "list_abc", limit: 10 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.entries).toHaveLength(1)
      expect(r.data.entries[0].entry_id).toBe("entry_1")
      expect(r.data.entries[0].record_id).toBe("rec_1")
    }
  })

  it("add_to_list creates a new entry when record is not yet in list", async () => {
    // first: query to check existing entries for this record — empty
    bridge.whenPost("/v2/lists/list_abc/entries/query").respondOnce(200, { data: [] })
    // then: POST to create entry
    bridge.whenPost("/v2/lists/list_abc/entries").respondOnce(200, {
      data: { id: { entry_id: "entry_new" } },
    })
    const r = await addToListImpl({
      list_id: "list_abc",
      record_id: "rec_1",
      parent_object: "people",
      entry_values: { stage: "Demo" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.entry_id).toBe("entry_new")
  })

  it("add_to_list updates entry when record already exists in list", async () => {
    bridge.whenPost("/v2/lists/list_abc/entries/query").respondOnce(200, {
      data: [{ id: { entry_id: "entry_existing" }, parent_object: "people", parent_record_id: "rec_1", entry_values: {} }],
    })
    bridge.whenPatch("/v2/lists/list_abc/entries/entry_existing").respondOnce(200, {
      data: { id: { entry_id: "entry_existing" } },
    })
    const r = await addToListImpl({
      list_id: "list_abc",
      record_id: "rec_1",
      parent_object: "people",
      entry_values: { stage: "Negotiation" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.entry_id).toBe("entry_existing")
    const patch = bridge.calls.find((c) => c.method === "PATCH")
    expect(patch).toBeTruthy()
  })
})
```

- [x] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

- [x] **Step 3: Add impls + registrations**

Append to `hola-boss-apps/attio/src/server/tools.ts`:

```typescript
// -------------------- Lists --------------------

export interface ListEntrySummary {
  entry_id: string
  record_id: string
  parent_object: string
  entry_values: Record<string, unknown>
}

export interface ListRecordsInListInput { list_id: string; limit?: number }
export async function listRecordsInListImpl(
  input: ListRecordsInListInput,
): Promise<Result<{ entries: ListEntrySummary[] } & ToolSuccessMeta, AttioError>> {
  const r = await apiPost<{ data: Array<Record<string, unknown>> }>(
    `/lists/${input.list_id}/entries/query`,
    { limit: input.limit ?? 50 },
  )
  if (!r.ok) return r
  const entries: ListEntrySummary[] = (r.data.data ?? []).map((e) => ({
    entry_id: e.id && typeof e.id === "object" && "entry_id" in (e.id as Record<string, unknown>)
      ? String((e.id as Record<string, unknown>).entry_id)
      : String(e.id ?? ""),
    record_id: String(e.parent_record_id ?? ""),
    parent_object: String(e.parent_object ?? ""),
    entry_values: (e.entry_values as Record<string, unknown>) ?? {},
  }))
  return {
    ok: true,
    data: { entries, result_summary: `Listed ${entries.length} entries in list ${input.list_id}` },
  }
}

export interface AddToListInput {
  list_id: string
  record_id: string
  parent_object: "people" | "companies" | "deals"
  entry_values?: Record<string, unknown>
}
export async function addToListImpl(
  input: AddToListInput,
): Promise<Result<{ entry_id: string } & ToolSuccessMeta, AttioError>> {
  // 1. query to see if record is already in the list
  const existing = await apiPost<{ data: Array<Record<string, unknown>> }>(
    `/lists/${input.list_id}/entries/query`,
    {
      limit: 1,
      filter: {
        parent_object: input.parent_object,
        parent_record_id: input.record_id,
      },
    },
  )
  if (!existing.ok) return existing
  const found = (existing.data.data ?? [])[0]

  if (found) {
    // update existing entry
    const entryId = found.id && typeof found.id === "object" && "entry_id" in (found.id as Record<string, unknown>)
      ? String((found.id as Record<string, unknown>).entry_id)
      : String(found.id ?? "")
    const r = await apiPatch<{ data: Record<string, unknown> }>(
      `/lists/${input.list_id}/entries/${entryId}`,
      { data: { entry_values: input.entry_values ?? {} } },
    )
    if (!r.ok) return r
    return {
      ok: true,
      data: {
        entry_id: entryId,
        attio_object: input.parent_object,
        attio_record_id: input.record_id,
        attio_deep_link: deepLinkFor(input.parent_object, input.record_id),
        result_summary: `Updated list entry ${entryId} in list ${input.list_id}`,
      },
    }
  }

  // create new entry
  const r = await apiPost<{ data: Record<string, unknown> }>(`/lists/${input.list_id}/entries`, {
    data: {
      parent_object: input.parent_object,
      parent_record_id: input.record_id,
      entry_values: input.entry_values ?? {},
    },
  })
  if (!r.ok) return r
  const raw = r.data.data ?? {}
  const entryId = raw.id && typeof raw.id === "object" && "entry_id" in (raw.id as Record<string, unknown>)
    ? String((raw.id as Record<string, unknown>).entry_id)
    : String(raw.id ?? "")
  return {
    ok: true,
    data: {
      entry_id: entryId,
      attio_object: input.parent_object,
      attio_record_id: input.record_id,
      attio_deep_link: deepLinkFor(input.parent_object, input.record_id),
      result_summary: `Added ${input.parent_object}/${input.record_id} to list ${input.list_id}`,
    },
  }
}
```

Extend `registerTools`:

```typescript
  const listRecordsInList = wrapTool("attio_list_records_in_list", listRecordsInListImpl)
  const addToList = wrapTool("attio_add_to_list", addToListImpl)

  server.tool(
    "attio_list_records_in_list",
    "List all entries in an Attio List (pipeline). Each entry has its own entry_values (e.g. stage, deal value) separate from the parent record's attributes. Use this to inspect a pipeline's current state.",
    {
      list_id: z.string().describe("Attio list id"),
      limit: z.number().int().positive().max(200).optional().describe("Max entries, default 50"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await listRecordsInList(args)) }] }),
  )

  server.tool(
    "attio_add_to_list",
    "Add a record to an Attio List, OR update its stage/entry_values if it is already in the list. This tool merges the 'add' and 'move stage' operations: if the record is not yet in the list, a new entry is created with the given entry_values; if it already exists, the existing entry's values are updated. entry_values are list-level attributes (stage, deal value, etc.), distinct from the parent record's attributes.",
    {
      list_id: z.string().describe("Attio list id"),
      record_id: z.string().describe("Attio record id of the person/company/deal to add"),
      parent_object: z.enum(["people", "companies", "deals"]).describe("Type of the record being added"),
      entry_values: z.record(z.unknown()).optional().describe("List-level entry attributes (e.g. stage, deal value)"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await addToList(args)) }] }),
  )
```

- [x] **Step 4: Run — expect pass**

```bash
pnpm test:unit
```

- [x] **Step 5: Commit**

```bash
git add src/server/tools.ts test/unit/tools-lists.test.ts
git commit -m "feat(attio): add list_records_in_list and add_to_list tools"
```

---

## Task 15: Connection status helper + server routes

**Files:**
- Create: `src/server/connection.ts`
- Create: `src/routes/api/health.ts`, `src/routes/api/connection-status.ts`, `src/routes/api/recent-actions.ts`, `src/routes/api/search.ts`, `src/routes/api/clear-feed.ts`

- [x] **Step 1: Create `src/server/connection.ts`**

```typescript
import { apiGet } from "./attio-client"

export interface ConnectionStatus {
  connected: boolean
  workspace_name?: string
  error?: string
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const r = await apiGet<{ data: { workspace_name?: string } }>("/self")
  if (r.ok) {
    return { connected: true, workspace_name: r.data.data?.workspace_name }
  }
  if (r.error.code === "not_connected") {
    return { connected: false }
  }
  return { connected: false, error: r.error.message }
}
```

- [x] **Step 2: Create `src/routes/api/health.ts`**

```typescript
import { createFileRoute } from "@tanstack/react-router"
import { createServerFileRoute } from "@tanstack/react-start/server"

export const ServerRoute = createServerFileRoute("/api/health").methods({
  GET: async () => {
    return new Response(JSON.stringify({ ok: true, module: "attio" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  },
})
```

- [x] **Step 3: Create `src/routes/api/connection-status.ts`**

```typescript
import { createServerFileRoute } from "@tanstack/react-start/server"
import { getConnectionStatus } from "../../server/connection"

export const ServerRoute = createServerFileRoute("/api/connection-status").methods({
  GET: async () => {
    const status = await getConnectionStatus()
    return new Response(JSON.stringify(status), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  },
})
```

- [x] **Step 4: Create `src/routes/api/recent-actions.ts`**

```typescript
import { createServerFileRoute } from "@tanstack/react-start/server"
import { listRecentActions } from "../../server/audit"

export const ServerRoute = createServerFileRoute("/api/recent-actions").methods({
  GET: async ({ request }) => {
    const url = new URL(request.url)
    const since = url.searchParams.get("since") ?? undefined
    const limit = Number(url.searchParams.get("limit") ?? 100)
    const actions = listRecentActions({ since, limit })
    return new Response(JSON.stringify({ actions }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  },
})
```

- [x] **Step 5: Create `src/routes/api/search.ts`**

```typescript
import { createServerFileRoute } from "@tanstack/react-start/server"
import { findPeopleImpl, findCompaniesImpl } from "../../server/tools"

export const ServerRoute = createServerFileRoute("/api/search").methods({
  POST: async ({ request }) => {
    const { query } = (await request.json()) as { query: string }
    const [people, companies] = await Promise.all([
      findPeopleImpl({ query, limit: 10 }),
      findCompaniesImpl({ query, limit: 10 }),
    ])
    return new Response(
      JSON.stringify({
        people: people.ok ? people.data.records : [],
        companies: companies.ok ? companies.data.records : [],
        errors: [
          ...(people.ok ? [] : [{ source: "people", ...people.error }]),
          ...(companies.ok ? [] : [{ source: "companies", ...companies.error }]),
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  },
})
```

- [x] **Step 6: Create `src/routes/api/clear-feed.ts`**

```typescript
import { createServerFileRoute } from "@tanstack/react-start/server"
import { clearActions } from "../../server/audit"

export const ServerRoute = createServerFileRoute("/api/clear-feed").methods({
  POST: async () => {
    const deleted = clearActions()
    return new Response(JSON.stringify({ deleted }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  },
})
```

- [x] **Step 7: Regenerate route tree + typecheck**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/attio
pnpm run typecheck
```

If `routeTree.gen.ts` is stale, run `pnpm dev:web` briefly (Ctrl+C after first HMR) to regenerate, or delete `src/routeTree.gen.ts` and let the next `pnpm build` regenerate it.

Expected: clean typecheck.

- [x] **Step 8: Commit**

```bash
git add src/server/connection.ts src/routes/api/ src/routeTree.gen.ts
git commit -m "feat(attio): add server routes for health, status, feed, search, clear"
```

---

## Task 16: UI components

**Files:**
- Create: `src/components/connection-status-bar.tsx`, `src/components/search-shortcut.tsx`, `src/components/activity-feed.tsx`

- [x] **Step 1: Create `src/components/connection-status-bar.tsx`**

```tsx
import { useEffect, useState } from "react"

interface Status {
  connected: boolean
  workspace_name?: string
  error?: string
}

export function ConnectionStatusBar() {
  const [status, setStatus] = useState<Status>({ connected: false })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch("/api/connection-status")
        if (r.ok && !cancelled) {
          const data = (await r.json()) as Status
          setStatus(data)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    const onFocus = () => poll()
    window.addEventListener("focus", onFocus)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener("focus", onFocus)
    }
  }, [])

  const frontendUrl = typeof window !== "undefined" ? window.location.origin : ""

  if (loading) {
    return (
      <div className="border-b border-border bg-muted/30 px-6 py-2 text-sm text-muted-foreground">
        Checking Attio connection…
      </div>
    )
  }

  if (status.error) {
    return (
      <div className="flex items-center justify-between border-b border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive">
        <span>Connection error: {status.error}</span>
        <a
          href={frontendUrl}
          className="underline hover:text-destructive-foreground"
        >
          Retry →
        </a>
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="flex items-center justify-between border-b border-amber-500/40 bg-amber-500/10 px-6 py-2 text-sm">
        <span className="text-amber-700 dark:text-amber-400">
          Not connected. Open Holaboss to connect Attio.
        </span>
        <a
          href={frontendUrl}
          className="text-amber-700 dark:text-amber-400 underline hover:text-foreground"
        >
          Connect Attio →
        </a>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-6 py-2 text-sm">
      <span className="flex items-center gap-2 text-foreground">
        <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
        Connected to Attio{status.workspace_name ? ` · ${status.workspace_name}` : ""}
      </span>
      <a
        href="https://app.attio.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-foreground"
      >
        Open Attio →
      </a>
    </div>
  )
}
```

- [x] **Step 2: Create `src/components/search-shortcut.tsx`**

```tsx
import { useEffect, useState } from "react"
import type { AttioRecord } from "../lib/types"

interface SearchResponse {
  people: AttioRecord[]
  companies: AttioRecord[]
}

export function SearchShortcut() {
  const [query, setQuery] = useState("")
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!query.trim()) {
      setResult(null)
      setError(null)
      return
    }
    const handle = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        })
        if (r.ok) {
          const data = (await r.json()) as SearchResponse
          setResult(data)
        } else {
          setError("Search failed")
        }
      } catch {
        setError("Search failed")
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(handle)
  }, [query])

  function extractName(record: AttioRecord): string {
    const v = record.values
    const nameField = v.name
    if (Array.isArray(nameField) && nameField[0]) {
      const first = nameField[0] as Record<string, unknown>
      return String(first.full_name ?? first.value ?? record.id)
    }
    return record.id
  }

  function extractSecondary(record: AttioRecord, kind: "person" | "company"): string {
    if (kind === "person") {
      const emails = record.values.email_addresses
      if (Array.isArray(emails) && emails[0]) {
        return String((emails[0] as Record<string, unknown>).email_address ?? emails[0])
      }
    } else {
      const domains = record.values.domains
      if (Array.isArray(domains) && domains[0]) {
        return String((domains[0] as Record<string, unknown>).domain ?? domains[0])
      }
    }
    return ""
  }

  return (
    <div className="border-b border-border px-6 py-4">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people or companies in Attio…"
        className="w-full rounded-md border border-input bg-background px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {loading && <div className="mt-2 text-xs text-muted-foreground">Searching…</div>}
      {error && <div className="mt-2 text-xs text-destructive">{error} · retry</div>}
      {result && !loading && !error && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">People</div>
            {result.people.length === 0 ? (
              <div className="text-xs text-muted-foreground">No matches</div>
            ) : (
              <ul className="space-y-2">
                {result.people.map((p) => (
                  <li key={p.id} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <div className="font-medium text-foreground">{extractName(p)}</div>
                    <div className="text-xs text-muted-foreground">{extractSecondary(p, "person")}</div>
                    <a
                      href={`https://app.attio.com/records/people/${p.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      Open in Attio →
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Companies</div>
            {result.companies.length === 0 ? (
              <div className="text-xs text-muted-foreground">No matches</div>
            ) : (
              <ul className="space-y-2">
                {result.companies.map((c) => (
                  <li key={c.id} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <div className="font-medium text-foreground">{extractName(c)}</div>
                    <div className="text-xs text-muted-foreground">{extractSecondary(c, "company")}</div>
                    <a
                      href={`https://app.attio.com/records/companies/${c.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      Open in Attio →
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [x] **Step 3: Create `src/components/activity-feed.tsx`**

```tsx
import { useEffect, useState } from "react"
import type { AgentActionRecord } from "../lib/types"

interface Props {
  initial: AgentActionRecord[]
}

export function ActivityFeed({ initial }: Props) {
  const [actions, setActions] = useState<AgentActionRecord[]>(initial)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch("/api/recent-actions?limit=100")
        if (r.ok && !cancelled) {
          const data = (await r.json()) as { actions: AgentActionRecord[] }
          setActions(data.actions)
        }
      } catch {
        /* ignore */
      }
    }
    const interval = setInterval(poll, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  async function clearFeed() {
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 3000)
      return
    }
    await fetch("/api/clear-feed", { method: "POST" })
    setActions([])
    setConfirming(false)
  }

  if (actions.length === 0) {
    return (
      <div className="px-6 py-12 text-center text-sm text-muted-foreground">
        No agent activity yet. Ask your agent to find or create a person in Attio.
      </div>
    )
  }

  return (
    <div className="px-6 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Activity
        </h2>
        <button
          type="button"
          onClick={clearFeed}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          {confirming ? "Click again to confirm" : "Clear feed"}
        </button>
      </div>
      <ul className="space-y-3">
        {actions.map((a) => (
          <li
            key={a.id}
            className={`rounded-md border px-4 py-3 text-sm ${
              a.outcome === "error"
                ? "border-destructive/40 bg-destructive/5"
                : "border-border bg-card"
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                    a.outcome === "success"
                      ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                      : "bg-destructive/20 text-destructive"
                  }`}
                  aria-hidden
                >
                  {a.outcome === "success" ? "✓" : "✗"}
                </span>
                <div className="flex-1">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(a.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="font-mono text-xs text-foreground">{a.tool_name}</span>
                  </div>
                  {a.result_summary && (
                    <div className="mt-1 text-foreground">{a.result_summary}</div>
                  )}
                  {a.error_code && (
                    <div className="mt-1 text-destructive">
                      <span className="font-mono text-xs">{a.error_code}</span>
                      {a.error_message && <span className="ml-2">{a.error_message}</span>}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [a.id]: !prev[a.id] }))
                    }
                    className="mt-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {expanded[a.id] ? "▾" : "▸"} args
                  </button>
                  {expanded[a.id] && (
                    <pre className="mt-2 overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
                      {JSON.stringify(JSON.parse(a.args_json), null, 2)}
                    </pre>
                  )}
                </div>
              </div>
              {a.attio_deep_link && (
                <a
                  href={a.attio_deep_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-primary hover:underline"
                >
                  Open in Attio →
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [x] **Step 4: Typecheck**

```bash
pnpm run typecheck
```

- [x] **Step 5: Commit**

```bash
git add src/components/
git commit -m "feat(attio): add connection status bar, search shortcut, activity feed"
```

---

## Task 17: Wire main page + root layout + styles

**Files:**
- Modify: `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/styles.css`

- [x] **Step 1: Update `src/routes/__root.tsx`**

```tsx
import { createRootRoute, Outlet } from "@tanstack/react-router"
import "../styles.css"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Attio CRM · Holaboss" },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <html lang="en">
      <head />
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Outlet />
      </body>
    </html>
  )
}
```

- [x] **Step 2: Update `src/routes/index.tsx` to load recent actions + wire components**

```tsx
import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { listRecentActions } from "../server/audit"
import { ConnectionStatusBar } from "../components/connection-status-bar"
import { SearchShortcut } from "../components/search-shortcut"
import { ActivityFeed } from "../components/activity-feed"
import type { AgentActionRecord } from "../lib/types"

const loadFeed = createServerFn({ method: "GET" }).handler(async () => {
  return { actions: listRecentActions({ limit: 100 }) as AgentActionRecord[] }
})

export const Route = createFileRoute("/")({
  loader: async () => loadFeed(),
  component: AttioHome,
})

function AttioHome() {
  const { actions } = Route.useLoaderData()
  return (
    <main className="mx-auto min-h-screen max-w-5xl">
      <header className="px-6 pt-8 pb-2">
        <h1 className="text-xl font-semibold">Attio CRM</h1>
        <p className="text-sm text-muted-foreground">Agent activity feed · pure proxy to your Attio workspace</p>
      </header>
      <ConnectionStatusBar />
      <SearchShortcut />
      <ActivityFeed initial={actions} />
    </main>
  )
}
```

- [x] **Step 3: Update `src/styles.css` with OKLch brand tokens**

Replace `hola-boss-apps/attio/src/styles.css`:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --background: oklch(0.98 0 0);
  --foreground: oklch(0.17 0.01 270);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.17 0.01 270);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.17 0.01 270);
  --primary: oklch(0.248 0.006 270);
  --primary-foreground: oklch(0.98 0 0);
  --secondary: oklch(0.95 0.003 270);
  --secondary-foreground: oklch(0.248 0.006 270);
  --muted: oklch(0.96 0.002 270);
  --muted-foreground: oklch(0.5 0.01 270);
  --accent: oklch(0.95 0.003 270);
  --accent-foreground: oklch(0.248 0.006 270);
  --destructive: oklch(0.577 0.245 27);
  --destructive-foreground: oklch(0.98 0 0);
  --border: oklch(0.92 0.003 270);
  --input: oklch(0.92 0.003 270);
  --ring: oklch(0.248 0.006 270);
  --radius: 0.5rem;
}

.dark {
  --background: oklch(0.17 0.01 270);
  --foreground: oklch(0.97 0.004 270);
  --card: oklch(0.21 0.008 270);
  --card-foreground: oklch(0.97 0.004 270);
  --popover: oklch(0.21 0.008 270);
  --popover-foreground: oklch(0.97 0.004 270);
  --primary: oklch(0.97 0.004 270);
  --primary-foreground: oklch(0.248 0.006 270);
  --secondary: oklch(0.25 0.008 270);
  --secondary-foreground: oklch(0.97 0.004 270);
  --muted: oklch(0.23 0.008 270);
  --muted-foreground: oklch(0.65 0.01 270);
  --accent: oklch(0.25 0.008 270);
  --accent-foreground: oklch(0.97 0.004 270);
  --destructive: oklch(0.577 0.245 27);
  --destructive-foreground: oklch(0.97 0.004 270);
  --border: oklch(0.27 0.008 270);
  --input: oklch(0.27 0.008 270);
  --ring: oklch(0.97 0.004 270);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --font-sans: "Inter", system-ui, sans-serif;
  --font-serif: "Newsreader", Georgia, serif;
}

body {
  font-family: var(--font-sans);
}
```

- [x] **Step 4: Typecheck + dev smoke**

```bash
pnpm run typecheck
pnpm run build
```

Expected: both succeed. If `routeTree.gen.ts` complains about unknown routes, run `pnpm dev:web`, Ctrl+C after HMR regenerates it, then rerun build.

- [x] **Step 5: Commit**

```bash
git add src/routes/ src/styles.css src/routeTree.gen.ts
git commit -m "feat(attio): wire main page with status bar, search, activity feed"
```

---

## Task 18: E2E test with mock bridge

**Files:**
- Create: `test/e2e.test.ts`

- [x] **Step 1: Write the E2E test**

`hola-boss-apps/attio/test/e2e.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MCP_PORT = 13091

describe("Attio Module E2E", () => {
  let mcpServer: Server | null = null
  let tmp: string

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "attio-e2e-"))
    process.env.DB_PATH = path.join(tmp, "attio-e2e.db")

    const { startMcpServer } = await import("../src/server/mcp")
    const { setBridgeClient } = await import("../src/server/attio-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")

    const bridge = new MockBridge()
    // default: connection works
    bridge.whenGet("/v2/self").respond(200, { data: { workspace_name: "Test WS" } })
    setBridgeClient(bridge.asClient())

    mcpServer = startMcpServer(MCP_PORT)
    await waitForServer(`http://localhost:${MCP_PORT}/mcp/health`)
  }, 15_000)

  afterAll(async () => {
    if (mcpServer) {
      await new Promise<void>((resolve) => mcpServer!.close(() => resolve()))
      mcpServer = null
    }
    const { closeDb } = await import("../src/server/db")
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("MCP health endpoint is live", async () => {
    const r = await fetch(`http://localhost:${MCP_PORT}/mcp/health`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.status).toBe("ok")
  })

  it("create_person writes an audit row", async () => {
    const { setBridgeClient } = await import("../src/server/attio-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { createPersonImpl } = await import("../src/server/tools")
    const { listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenPost("/v2/objects/people/records").respond(200, {
      data: { id: { record_id: "rec_e2e_1" } },
    })
    setBridgeClient(bridge.asClient())

    // Note: We call the impl directly because wrapTool is registered on the MCP layer;
    // re-wrap here to exercise the audit path:
    const { wrapTool } = await import("../src/server/audit")
    const wrapped = wrapTool("attio_create_person", createPersonImpl)
    const result = await wrapped({ attributes: { name: "E2E User" } })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    const match = rows.find((r) => r.attio_record_id === "rec_e2e_1")
    expect(match).toBeDefined()
    expect(match!.outcome).toBe("success")
  })

  it("tool failure writes an error audit row", async () => {
    const { setBridgeClient } = await import("../src/server/attio-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { createPersonImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenPost("/v2/objects/people/records").respond(422, {
      message: "Required attribute missing",
    })
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("attio_create_person", createPersonImpl)
    const result = await wrapped({ attributes: {} })
    expect(result.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    const errorRow = rows.find((r) => r.outcome === "error" && r.error_code === "validation_failed")
    expect(errorRow).toBeDefined()
    expect(errorRow!.error_message).toContain("Required")
  })

  it("not_connected short-circuits before bridge call", async () => {
    const { setBridgeClient } = await import("../src/server/attio-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { createPersonImpl } = await import("../src/server/tools")

    const bridge = new MockBridge()
    bridge.whenAny().throwOnce(new Error("No attio integration configured"))
    setBridgeClient(bridge.asClient())

    const result = await createPersonImpl({ attributes: { name: "X" } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("not_connected")
  })
})

async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Server not ready at ${url} after ${timeoutMs}ms`)
}
```

- [x] **Step 2: Run E2E**

```bash
pnpm test:e2e
```

Expected: 4 tests PASS.

- [x] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: all unit + e2e tests PASS. If any cross-test DB contamination surfaces, isolate tests by giving each file its own `DB_PATH` via `resetDbForTests`.

- [x] **Step 4: Commit**

```bash
git add test/e2e.test.ts
git commit -m "test(attio): add E2E tests against mock bridge"
```

---

## Task 19: Dockerfile + docs

**Files:**
- Modify: `Dockerfile`, `README.md`

- [x] **Step 1: Verify `Dockerfile` is template-correct**

Read `hola-boss-apps/attio/Dockerfile`. It should already work from the template copy. Confirm it:
1. Uses Node 20 Alpine
2. Runs `pnpm install --maxsockets 1 && pnpm run build`
3. Starts both web and services processes
4. Exposes 8080 and 3099

If anything references "template" or "module-template" by name, replace with "attio".

- [x] **Step 2: Rewrite `README.md`**

`hola-boss-apps/attio/README.md`:

```markdown
# Attio Module

A Holaboss module that gives the workspace agent CRM capabilities against the user's Attio workspace via bridge+Composio.

## What it does

Exposes 14 MCP tools for reading and writing Attio — people, companies, notes, tasks, lists, and schema inspection. All data operations are pure proxy: Attio is the source of truth. The module stores only an append-only audit log (`agent_actions`) of every tool call, which powers an Activity Feed UI.

## Tools

| Tool | Purpose |
|------|---------|
| `attio_describe_schema` | Inspect workspace schema (objects + attributes, including custom fields) |
| `attio_get_connection_status` | Check if Attio is connected |
| `attio_find_people` | Fuzzy search people by name or email |
| `attio_get_person` | Fetch a single person by record id |
| `attio_create_person` | Create a person |
| `attio_update_person` | Patch a person's attributes |
| `attio_find_companies` | Fuzzy search companies by name or domain |
| `attio_create_company` | Create a company |
| `attio_link_person_to_company` | Link a person to a company |
| `attio_add_note` | Add a plaintext note to a person, company, or deal |
| `attio_create_task` | Create a to-do with optional deadline and linked records |
| `attio_list_tasks` | List tasks with optional filters |
| `attio_list_records_in_list` | Read pipeline members with their entry_values |
| `attio_add_to_list` | Add or update a record in a pipeline list |

## Architecture

Pure proxy. No local business data. See `docs/superpowers/specs/2026-04-14-attio-crm-module-design.md` for the full design.

## Development

```bash
pnpm install --maxsockets 1
pnpm run dev          # start web + MCP + services
pnpm test             # run unit + integration + e2e (mock bridge)
pnpm run build        # production build
```

## Environment variables

- `HOLABOSS_APP_GRANT` — workspace grant token (set by sandbox runtime)
- `HOLABOSS_INTEGRATION_BROKER_URL` — broker URL (set by sandbox runtime)
- `HOLABOSS_FRONTEND_URL` — frontend URL for the "Connect Attio" link
- `DB_PATH` — SQLite file path (default: `./data/attio.db`)
- `PORT` / `MCP_PORT` — web / MCP server ports
```

- [x] **Step 3: Commit**

```bash
git add Dockerfile README.md
git commit -m "docs(attio): add module README and verify Dockerfile"
```

---

## Task 20: Production build + final smoke

**Files:** (none new)

- [x] **Step 1: Clean build**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/attio
rm -rf .output dist
pnpm run build
```

Expected: `.output/server/index.mjs` and `.output/start-services.cjs` exist, no errors.

- [x] **Step 2: Full test suite**

```bash
pnpm test
```

Expected: every unit test + e2e test passes.

- [x] **Step 3: Typecheck + lint**

```bash
pnpm run typecheck
pnpm run lint
```

Expected: clean.

- [x] **Step 4: Boot locally and manual smoke**

```bash
pnpm run dev
```

In another terminal:
```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/connection-status
curl http://localhost:3099/mcp/health
```

Expected:
- `/api/health` → `{"ok":true,"module":"attio"}`
- `/api/connection-status` → `{"connected":false}` or an error response (real bridge isn't mocked here)
- `/mcp/health` → `{"status":"ok"}`

Stop with Ctrl+C.

- [x] **Step 5: Commit + final push**

```bash
git status  # should be clean
git log --oneline -20
```

If everything is in order, push the branch:

```bash
git push -u origin HEAD
```

---

## Task 21: Workspace integration smoke (manual, deferred)

This is a validation gate, not a code task. Runs once the module is deployed into a Holaboss workspace.

- [x] **Step 1: Install the module in a Holaboss workspace**

Use the workspace template mechanism to add `attio` to a test workspace. Verify:
1. `app.runtime.yaml` `lifecycle.setup` runs successfully in the sandbox
2. `lifecycle.start` launches both web and MCP processes
3. The MCP healthcheck at `/mcp/health` passes within 30s
4. The 14 `attio_*` tools appear in the agent's tool list

- [x] **Step 2: Run a real SDR flow**

Ask the agent to execute the following chain, observing the Activity Feed after each step:
1. "Find John Smith from Acme Corp on LinkedIn" → (linkedin module finds a lead)
2. "Check if he's in my Attio already" → `attio_find_people`
3. "Create him in Attio with his role and email" → `attio_describe_schema` + `attio_create_person`
4. "Add a note saying 'referred by partner'" → `attio_add_note`
5. "Create a follow-up task for Friday" → `attio_create_task`
6. "Add him to my Q2 prospects list, stage = Discovery" → `attio_add_to_list`

Expected:
- Every operation appears in the Activity Feed within 3s
- Every "Open in Attio →" deep link resolves to the correct record
- Any validation failure displays with the exact Attio error message

- [x] **Step 3: Record demo video**

Capture the agent chat + Activity Feed side-by-side for the marketing/demo asset.

---

## Self-Review

Checked against `docs/superpowers/specs/2026-04-14-attio-crm-module-design.md`:

**Spec coverage:**
- §1 Goals / Scope / Non-Goals → implied by task content; out-of-scope items not implemented
- §2 Architecture (single bridge gateway, two processes, single SQLite table) → Tasks 2, 5, 6, 8
- §3 Data Model (agent_actions schema) → Task 2 (db.ts), Task 5 (tests), Task 6 (audit.ts)
- §4 Tool Surface (14 tools) → Tasks 10–14 (describe_schema+status: 10, people: 11, companies: 12, notes+tasks: 13, lists: 14)
- §5 Web UI (status bar, search, feed, clear, server routes) → Tasks 15, 16, 17
- §6 Error Handling (4 codes, centralized mapping, no retries, not_connected short-circuit) → Task 8 (attio-client), tested in Tasks 8, 11, 18
- §7 Testing Strategy (unit, integration, E2E with mock bridge, shared fixture) → Tasks 4, 7, 18
- §8 Open Questions → Pre-Task spike (§8.1), §8.2 list semantics surfaced in Task 14 + tool description, §8.3 rate limits pass-through in Task 8, §8.4 v1 scoping respected, §8.5 query builder in Task 9, §8.6 timezone hint in Task 13 tool description
- §9 Implementation Path → Tasks 1–20 map 1:1 onto the 10-step skeleton (more granular)
- §10 Module Metadata (name, dir, brand color, env vars, healthcheck) → Task 1 (app.runtime.yaml), Task 17 (styles.css), Task 19 (README), Task 20 (smoke test)

**Placeholders:** none. Every code step shows complete, copy-pasteable code. No "TBD" or "similar to above".

**Type consistency:**
- `Result<T, AttioError>` used consistently across `attio-client`, `tools`, `audit`
- `ToolSuccessMeta` fields referenced in `audit.ts` match the optional properties defined in `types.ts`
- `AgentActionRecord` column names match `db.ts` schema verbatim
- Tool input types (`FindPeopleInput`, `CreatePersonInput`, etc.) match the zod schemas in `registerTools`
- `MODULE_CONFIG.brandColor` matches the `--primary` value in `styles.css`

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-14-attio-crm-module.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with review checkpoints between tasks. Best for this plan because each task is cohesive, self-contained, and TDD-driven, which matches the subagent review cadence well.

**2. Inline Execution** — Execute tasks in this session using the executing-plans skill, batch execution with user-approved checkpoints.

**Which approach?**
