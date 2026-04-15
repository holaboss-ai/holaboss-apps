# Cal.com Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `hola-boss-apps/calcom/` — a pure-proxy Cal.com integration that exposes 8 MCP tools to the workspace agent (event types, bookings, availability, reschedule/cancel), backed by bridge+Composio, with the same single-table audit log + Activity Feed UI pattern as the Attio module.

**Architecture:** Two-process TanStack Start module (web + services), identical shape to `attio/`. `src/server/calcom-client.ts` is the single gateway to `holaboss-bridge.createIntegrationClient("calcom")`. Tools are typed, thin call+transform functions wrapped by `wrapTool()`, which appends a row to `agent_actions` on every call. No business data stored locally; Cal.com is the source of truth.

**Tech Stack:** TanStack Start v1, React 19, `better-sqlite3`, `@modelcontextprotocol/sdk`, Zod, Tailwind v4 + OKLch tokens, Vitest, pnpm. Copied from `_template/` like all other modules.

**Predecessors:** Builds on the patterns validated by `hola-boss-apps/attio/` (see `docs/superpowers/plans/2026-04-14-attio-crm-module.md`). Many tasks intentionally mirror Attio's shape 1:1 because the author of this plan is betting that shared mental model across modules is more valuable than incremental cleverness.

---

## Up-front Design Decisions (made without brainstorming, per user instruction)

| # | Decision | Rationale |
|---|---|---|
| 1 | Module name `calcom`, tool prefix `calcom_` | TypeScript/filesystem-friendly; mirrors existing naming convention |
| 2 | Pure proxy (no local business data) | Identical to Attio; Cal.com is source of truth |
| 3 | Single SQLite table `agent_actions` | Same shape as Attio; powers the Activity Feed |
| 4 | Auth via bridge + Composio, **provider slug = `"cal"`** (verified against `docs.composio.dev/toolkits/cal`, NOT `"calcom"`). Call signature: `createIntegrationClient("cal")` | Verified via Composio docs query 2026-04-15. All Composio action names use the `CAL_*` prefix. |
| 5 | 8 MCP tools, all with typed params (not `Record<string, unknown>`) | Cal.com has fixed schemas — no dynamic attribute discovery needed |
| 6 | No main-calendar write operations (no direct booking creation, no availability rule edits) | Agent directly creating bookings is the same reverse-of-SDR-mental-model mistake as writing to Google Calendar. The correct model is: agent shares event type URLs, prospects self-book. v1 only exposes read + cancel/reschedule of existing bookings. |
| 7 | UI = Activity Feed (main) + Connection Bar (top) + **Upcoming Bookings** panel (replaces Attio's Search Shortcut, since search doesn't map to calendars) | — |
| 8 | Brand color `oklch(0.2 0 0)` (near pure black, zero chroma) for light-mode primary; inverted to near-white for dark | Cal.com's actual brand is minimal monochrome; pure-black/white pairs well next to Attio's near-black and gmail's blue in a workspace |
| 9 | Error handling: identical 4-code scheme (`not_connected`, `rate_limited`, `validation_failed`, `upstream_error`) | Copy Attio's `attio-client.ts` pattern verbatim, change only the `isNotConnectedError` and API base URL |
| 10 | Testing: unit + integration + e2e with mock bridge, no live-Cal.com in CI | Same strategy as Attio |
| 11 | Cal.com API v2 is assumed as the target (base: `https://api.cal.com/v2`). Because bridge uses the Composio **proxy** mode (hitting `api.cal.com/v2/*` directly, not Composio action endpoints), we need to verify the real Cal.com endpoint shapes during spike — specifically: (a) whether `GET /event-types` works as a connection probe, (b) whether slots is `GET /slots?...` or `POST /slots`, (c) the exact field names in bookings list (`start`/`startTime`, `uid`/`id`), (d) whether booking identifiers are UIDs (string) or numeric ids. Composio toolkit docs show that bookings use a UID string (e.g. `"clp123abc"`), so mapper code already treats `booking_id` as a string. | Cal.com v2 API shape has drifted over versions; plan's mapper code is tolerant (handles both `start`/`startTime` etc.) but the spike MUST confirm the actual fields returned and patch the mappers inline before implementing. |

---

## Task 0: Spike — verify the Cal.com integration and capture real API shapes

This is not a code task. Required before Task 1, but it is lower-risk than Attio's spike was: Composio **is** confirmed to support Cal.com (verified 2026-04-15 against `docs.composio.dev/toolkits/cal`). The spike here is primarily about capturing real Cal.com API response shapes, because the plan's mappers are based on documented shapes that may drift.

**What we already know (verified via Composio docs):**
- Composio toolkit slug: **`cal`** (confirmed — URL `/toolkits/cal.md`, all action names `CAL_*`)
- Auth scheme: **OAuth2, Composio-managed** — no client secret handling on our side
- Cal.com IS in Composio's supported toolkit list; no fallback path is expected to be needed
- Booking identifiers are **UID strings** (e.g. `"clp123abc"`), not numeric ids — Composio's `CAL_CANCEL_BOOKING_VIA_UID` confirms this. Mapper code in Task 9 already treats `booking_id` as a string.

- [ ] **Step 1: Connect Cal.com from the Holaboss frontend**

1. Open Holaboss integrations page
2. Connect Cal.com via Composio OAuth
3. Confirm a connection binding is created and visible for the current workspace
4. If this step fails, it means Composio's Cal.com connector is misconfigured in the Holaboss Composio account. Check Composio dashboard and contact Composio support.

- [ ] **Step 2: Smoke the direct Cal.com API via bridge**

From any running module (e.g. `twitter`), run this one-off script. Note: provider slug is **`cal`**, not `calcom`.

```bash
cd hola-boss-apps/twitter
pnpm exec tsx -e '
  import { createIntegrationClient } from "./src/server/holaboss-bridge.js";
  const c = createIntegrationClient("cal");

  // Connection probe — event-types is the safest "am I connected" endpoint
  const et = await c.proxy({ method: "GET", endpoint: "https://api.cal.com/v2/event-types" });
  console.log("event-types:", et.status, JSON.stringify(et.data).slice(0, 800));

  // List recent bookings
  const bk = await c.proxy({ method: "GET", endpoint: "https://api.cal.com/v2/bookings?take=5" });
  console.log("bookings:", bk.status, JSON.stringify(bk.data).slice(0, 800));

  // Try slots — Cal.com v2 uses GET /slots with query params as of 2026-04,
  // but if this returns 404 or 405, try POST with a body (Composio documents slots as POST)
  const slots = await c.proxy({
    method: "GET",
    endpoint: "https://api.cal.com/v2/slots?eventTypeId=1&startTime=2026-04-20T00:00:00Z&endTime=2026-04-21T00:00:00Z",
  });
  console.log("slots:", slots.status, JSON.stringify(slots.data).slice(0, 800));
'
```

Expected: `event-types` and `bookings` return `status: 200` with non-empty JSON. Slots may need adjustment — see Step 3.

- [ ] **Step 3: Capture and diff real response shapes**

Copy the real JSON responses into a scratch file. Specifically verify each of these, because Task 9's mapper code depends on them:

| Field needed | Plan assumes | Verify in spike |
|---|---|---|
| Event type id type | string-coerced from number | Could be number or string — mapper already `String()`-coerces |
| Event type title | `title` | — |
| Event type length | `lengthInMinutes` OR `length` | Mapper checks both |
| Event type booking URL | `schedulingUrl` OR `link` | Mapper checks both |
| Booking id | `id` (string UID like `clp123abc`) | — |
| Booking start | `start` OR `startTime` | Mapper checks both |
| Booking attendees | array of `{name, email, timeZone}` | — |
| Booking status values | `"ACCEPTED"`, `"PENDING"`, `"CANCELLED"` | — |
| Slots endpoint method | `GET /slots?...` | **CHECK** — if real API uses POST, update `listAvailableSlotsImpl` in Task 9 to use `apiPost` with the body shape from Composio's `CAL_GET_AVAILABLE_SLOTS_INFO` docs |
| Cancel endpoint path | `POST /bookings/{uid}/cancel` with body `{cancellationReason}` | — (Composio docs confirm) |
| Reschedule endpoint path | `POST /bookings/{uid}/reschedule` with body `{start, reschedulingReason}` | **CHECK** — verify the exact field names; Cal.com v2 may use different keys |

**If any shape deviates from the plan assumptions, patch the mapper/endpoint inline in Task 9 before running tests.** Do not proceed to Task 1 until these are locked.

- [ ] **Step 4: Fallback (unlikely)**

Composio support for Cal.com is confirmed, so failure modes here are narrow:

- **If OAuth flow fails**: check that the Holaboss Composio account has the `cal` toolkit enabled (Composio dashboard → Toolkits). This is a configuration issue, not a code issue.
- **If proxy returns 401/403 after successful OAuth**: scopes are insufficient. Check Composio's Cal.com scope list and re-request with the right scopes from Composio dashboard. This is also config, not code.
- **If an endpoint returns 404 (path changed)**: Cal.com v2 API path for that resource has changed — update the endpoint string in Task 9 and re-run the spike.

No "fallback to direct OAuth" or "use v1 legacy API" paths are needed anymore — Composio coverage is confirmed.

---

## Task 1: Scaffold `calcom/` from `_template/`

**Files:**
- Create: `hola-boss-apps/calcom/` (copied from `_template/`)
- Modify: `package.json`, `app.runtime.yaml`, `docker-compose.yml`, `README.md`

- [ ] **Step 1: Copy template**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps
cp -R _template calcom
rm -rf calcom/node_modules calcom/pnpm-lock.yaml calcom/dist calcom/.output calcom/data
```

- [ ] **Step 2: Set `package.json` name**

Edit `hola-boss-apps/calcom/package.json`, change only the `name` field:
```json
{
  "name": "calcom-module",
  ...
}
```

- [ ] **Step 3: Overwrite `app.runtime.yaml`**

`hola-boss-apps/calcom/app.runtime.yaml`:

```yaml
app_id: "calcom"
name: "Cal.com"
slug: "calcom"

lifecycle:
  setup: "rm -rf node_modules && corepack enable && pnpm install --maxsockets 1 && pnpm run build && pnpm prune --prod"
  start: "DB_PATH=./data/calcom.db nohup node .output/server/index.mjs > /tmp/calcom.log 2>&1 & DB_PATH=./data/calcom.db nohup node .output/start-services.cjs > /tmp/calcom-services.log 2>&1 &"
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
    - calcom_get_connection_status
    - calcom_list_event_types
    - calcom_get_event_type
    - calcom_list_bookings
    - calcom_get_booking
    - calcom_cancel_booking
    - calcom_reschedule_booking
    - calcom_list_available_slots

integration:
  destination: "calcom"
  credential_source: "platform"
  holaboss_user_id_required: true

env_contract:
  - "HOLABOSS_APP_GRANT"
  - "HOLABOSS_INTEGRATION_BROKER_URL"
  - "HOLABOSS_WORKSPACE_ID"
  - "HOLABOSS_USER_ID"
  - "HOLABOSS_FRONTEND_URL"
```

- [ ] **Step 4: Update `docker-compose.yml`**

Replace `hola-boss-apps/calcom/docker-compose.yml`:

```yaml
services:
  calcom:
    build: .
    container_name: calcom-module
    ports:
      - "8080:8080"
      - "3099:3099"
    environment:
      - DB_PATH=/app/data/calcom.db
      - PORT=8080
      - MCP_PORT=3099
    volumes:
      - calcom-data:/app/data

volumes:
  calcom-data:
```

- [ ] **Step 5: Install deps**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/calcom
pnpm install --maxsockets 1
```

- [ ] **Step 6: Commit**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/calcom
git add .
git commit -m "feat(calcom): scaffold module from _template"
```

---

## Task 2: Strip template's posts/queue code

**Files:**
- Delete: `src/server/queue.ts`, `src/server/publisher.ts`, `src/server/actions.ts`, `src/routes/posts.$postId.tsx`, `test/e2e.test.ts`
- Replace: `src/server/start-services.ts`, `src/server/mcp.ts`, `src/server/db.ts`, `src/server/bootstrap.ts`, `src/routes/index.tsx`

- [ ] **Step 1: Delete unused files**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/calcom
rm src/server/queue.ts src/server/publisher.ts src/server/actions.ts
rm src/routes/posts.\$postId.tsx
rm test/e2e.test.ts
```

- [ ] **Step 2: Replace `src/server/start-services.ts`**

```typescript
#!/usr/bin/env tsx
import { startMcpServer } from "./mcp.js"

const MCP_PORT = Number(process.env.MCP_PORT ?? 3099)

startMcpServer(MCP_PORT)

console.log("[calcom] MCP server started")
```

- [ ] **Step 3: Replace `src/server/mcp.ts` with shell**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer } from "node:http"

import { registerTools } from "./tools"

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "Cal.com Module",
    version: "1.0.0",
  })
  registerTools(server)
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

Note: `registerTools` does not yet exist — it's added in Task 9. `pnpm run typecheck` will fail until then; that's expected.

- [ ] **Step 4: Replace `src/server/db.ts`**

```typescript
import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import path from "node:path"

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "calcom.db")
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
      calcom_object   TEXT,
      calcom_record_id TEXT,
      calcom_deep_link TEXT,
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

export function resetDbForTests(dbPath: string) {
  if (_db) {
    _db.close()
    _db = null
  }
  process.env.DB_PATH = dbPath
}
```

- [ ] **Step 5: Replace `src/server/bootstrap.ts`**

```typescript
import { getDb } from "./db"

let bootstrapped = false

export function ensureBootstrapped(): void {
  if (bootstrapped) return
  getDb()
  bootstrapped = true
}
```

- [ ] **Step 6: Replace `src/routes/index.tsx` with minimal placeholder**

```tsx
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
  component: CalcomHome,
})

function CalcomHome() {
  return (
    <main className="min-h-screen bg-background text-foreground p-8">
      <h1 className="text-2xl font-semibold">Cal.com</h1>
      <p className="text-muted-foreground mt-2">
        Module shell — UI components land in Task 11.
      </p>
    </main>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(calcom): remove template posts/queue code, reset shell"
```

---

## Task 3: Types

**Files:**
- Replace: `src/lib/types.ts`

- [ ] **Step 1: Overwrite `src/lib/types.ts`**

```typescript
export type CalcomErrorCode =
  | "not_connected"
  | "rate_limited"
  | "validation_failed"
  | "upstream_error"

export interface CalcomError {
  code: CalcomErrorCode
  message: string
  retry_after?: number
}

export type Result<T, E = CalcomError> =
  | { ok: true; data: T }
  | { ok: false; error: E }

export interface EventTypeSummary {
  id: string
  slug: string
  title: string
  length_minutes: number
  description: string | null
  booking_url: string
  location_type: string | null
}

export interface BookingAttendee {
  name: string
  email: string
  timezone?: string
}

export interface BookingSummary {
  id: string
  title: string
  start_time: string
  end_time: string
  status: string
  event_type_id: string | null
  attendees: BookingAttendee[]
  location: string | null
  meeting_url: string | null
}

export interface AvailabilitySlot {
  start: string
  end: string
}

export interface AgentActionRecord {
  id: string
  timestamp: number
  tool_name: string
  args_json: string
  outcome: "success" | "error"
  duration_ms: number
  calcom_object: string | null
  calcom_record_id: string | null
  calcom_deep_link: string | null
  result_summary: string | null
  error_code: string | null
  error_message: string | null
}

export interface ToolSuccessMeta {
  calcom_object?: string
  calcom_record_id?: string
  calcom_deep_link?: string
  result_summary?: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
  brandColor: string
}

export const MODULE_CONFIG: PlatformConfig = {
  provider: "calcom",
  destination: "calcom",
  name: "Cal.com",
  brandColor: "oklch(0.2 0 0)",
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(calcom): add core types and error codes"
```

---

## Task 4: Vitest config + test directory layout

**Files:**
- Create: `vitest.config.ts`, `test/unit/`, `test/integration/`, `test/fixtures/`

- [ ] **Step 1: Create `vitest.config.ts`**

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

- [ ] **Step 2: Create directories**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/calcom
mkdir -p test/unit test/integration test/fixtures
touch test/unit/.gitkeep test/integration/.gitkeep test/fixtures/.gitkeep
```

- [ ] **Step 3: Update `package.json` scripts**

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

Keep all other scripts (`dev`, `build`, `typecheck`, `lint`, `format`) unchanged.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts test/ package.json
git commit -m "chore(calcom): add vitest config and test directory layout"
```

---

## Task 5: Database layer (TDD)

**Files:**
- Test: `test/unit/db.test.ts`

- [ ] **Step 1: Write the failing tests**

`hola-boss-apps/calcom/test/unit/db.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, migrate, resetDbForTests } from "../../src/server/db"

describe("db", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "calcom-db-"))
    resetDbForTests(path.join(tmp, "calcom.db"))
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
        "calcom_deep_link",
        "calcom_object",
        "calcom_record_id",
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

- [ ] **Step 2: Run test — expect pass**

```bash
pnpm test:unit
```

Expected: 3 tests PASS (implementation already landed in Task 2).

- [ ] **Step 3: Commit**

```bash
git add test/unit/db.test.ts
git commit -m "test(calcom): cover db migration and schema"
```

---

## Task 6: Audit log `wrapTool` HOF (TDD)

**Files:**
- Create: `src/server/audit.ts`
- Test: `test/unit/audit.test.ts`

- [ ] **Step 1: Write failing tests**

`hola-boss-apps/calcom/test/unit/audit.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { clearActions, listRecentActions, wrapTool } from "../../src/server/audit"
import type { Result, CalcomError } from "../../src/lib/types"

describe("audit.wrapTool", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "calcom-audit-"))
    resetDbForTests(path.join(tmp, "calcom.db"))
    getDb()
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("appends a success row for a successful call", async () => {
    const tool = wrapTool(
      "calcom_test_tool",
      async (args: { foo: string }): Promise<Result<{ calcom_record_id: string; result_summary: string }, CalcomError>> => {
        return { ok: true, data: { calcom_record_id: "bk_1", result_summary: "cancelled booking bk_1" } }
      },
    )

    const result = await tool({ foo: "bar" })
    expect(result.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "calcom_test_tool",
      outcome: "success",
      calcom_record_id: "bk_1",
      result_summary: "cancelled booking bk_1",
      error_code: null,
    })
    expect(JSON.parse(rows[0].args_json)).toEqual({ foo: "bar" })
  })

  it("appends an error row for a failed call", async () => {
    const tool = wrapTool("calcom_test_tool", async (): Promise<Result<{ calcom_record_id: string }, CalcomError>> => {
      return { ok: false, error: { code: "validation_failed", message: "Booking not found" } }
    })

    const result = await tool({})
    expect(result.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    expect(rows[0]).toMatchObject({
      outcome: "error",
      error_code: "validation_failed",
      error_message: "Booking not found",
      calcom_record_id: null,
    })
  })

  it("listRecentActions orders by timestamp DESC", async () => {
    const tool = wrapTool("calcom_test_tool", async (): Promise<Result<Record<string, never>, CalcomError>> => ({ ok: true, data: {} }))
    await tool({ n: 1 })
    await new Promise((r) => setTimeout(r, 5))
    await tool({ n: 2 })
    await new Promise((r) => setTimeout(r, 5))
    await tool({ n: 3 })
    const rows = listRecentActions({ limit: 10 })
    expect(rows.map((r) => JSON.parse(r.args_json).n)).toEqual([3, 2, 1])
  })

  it("clearActions truncates the table", async () => {
    const tool = wrapTool("calcom_test_tool", async (): Promise<Result<Record<string, never>, CalcomError>> => ({ ok: true, data: {} }))
    await tool({})
    await tool({})
    expect(clearActions()).toBe(2)
    expect(listRecentActions({ limit: 10 })).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

Expected: FAIL — `Cannot find module '../../src/server/audit'`.

- [ ] **Step 3: Implement `src/server/audit.ts`**

```typescript
import { randomUUID } from "node:crypto"

import { getDb } from "./db"
import type { AgentActionRecord, CalcomError, Result, ToolSuccessMeta } from "../lib/types"

type ToolFn<A, T> = (args: A) => Promise<Result<T & ToolSuccessMeta, CalcomError>>

export function wrapTool<A, T>(toolName: string, fn: ToolFn<A, T>): ToolFn<A, T> {
  return async (args: A) => {
    const start = Date.now()
    let result: Result<T & ToolSuccessMeta, CalcomError>
    try {
      result = await fn(args)
    } catch (e) {
      result = {
        ok: false,
        error: { code: "upstream_error", message: e instanceof Error ? e.message : String(e) },
      }
    }
    recordAction(toolName, args, result, Date.now() - start)
    return result
  }
}

function recordAction<A, T>(
  toolName: string,
  args: A,
  result: Result<T & ToolSuccessMeta, CalcomError>,
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
    calcom_object: result.ok ? result.data.calcom_object ?? null : null,
    calcom_record_id: result.ok ? result.data.calcom_record_id ?? null : null,
    calcom_deep_link: result.ok ? result.data.calcom_deep_link ?? null : null,
    result_summary: result.ok ? result.data.result_summary ?? null : null,
    error_code: result.ok ? null : result.error.code,
    error_message: result.ok ? null : result.error.message,
  }
  db.prepare(`
    INSERT INTO agent_actions (
      id, timestamp, tool_name, args_json, outcome, duration_ms,
      calcom_object, calcom_record_id, calcom_deep_link, result_summary,
      error_code, error_message
    ) VALUES (
      @id, @timestamp, @tool_name, @args_json, @outcome, @duration_ms,
      @calcom_object, @calcom_record_id, @calcom_deep_link, @result_summary,
      @error_code, @error_message
    )
  `).run(row)
}

export function listRecentActions(params: { since?: string; limit?: number }): AgentActionRecord[] {
  const db = getDb()
  const limit = params.limit ?? 100
  if (params.since) {
    return db
      .prepare(`SELECT * FROM agent_actions WHERE id > @since ORDER BY timestamp DESC LIMIT @limit`)
      .all({ since: params.since, limit }) as AgentActionRecord[]
  }
  return db
    .prepare(`SELECT * FROM agent_actions ORDER BY timestamp DESC LIMIT @limit`)
    .all({ limit }) as AgentActionRecord[]
}

export function clearActions(): number {
  const db = getDb()
  return db.prepare("DELETE FROM agent_actions").run().changes
}
```

- [ ] **Step 4: Run — expect pass**

```bash
pnpm test:unit
```

- [ ] **Step 5: Commit**

```bash
git add src/server/audit.ts test/unit/audit.test.ts
git commit -m "feat(calcom): add agent_actions audit log with wrapTool HOF"
```

---

## Task 7: Mock bridge fixture

**Files:**
- Create: `test/fixtures/mock-bridge.ts`

- [ ] **Step 1: Write fixture**

`hola-boss-apps/calcom/test/fixtures/mock-bridge.ts`:

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

type Responder = (req: ProxyRequestLike) => ProxyResponseLike | Promise<ProxyResponseLike> | { throw: Error }

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

  whenGet(suffix: string) { return this.matcher("GET", (e) => e.includes(suffix)) }
  whenPost(suffix: string) { return this.matcher("POST", (e) => e.includes(suffix)) }
  whenPatch(suffix: string) { return this.matcher("PATCH", (e) => e.includes(suffix)) }
  whenDelete(suffix: string) { return this.matcher("DELETE", (e) => e.includes(suffix)) }
  whenAny() { return this.matcher(undefined, () => true) }

  private matcher(method: string | undefined, matchEndpoint: (e: string) => boolean) {
    const self = this
    return {
      respond(status: number, data: unknown = {}, headers: Record<string, string> = {}) {
        self.rules.push({ method, matchEndpoint, once: false, consumed: false, respond: () => ({ data, status, headers }) })
        return self
      },
      respondOnce(status: number, data: unknown = {}, headers: Record<string, string> = {}) {
        self.rules.push({ method, matchEndpoint, once: true, consumed: false, respond: () => ({ data, status, headers }) })
        return self
      },
      throwOnce(error: Error) {
        self.rules.push({ method, matchEndpoint, once: true, consumed: false, respond: () => ({ throw: error }) })
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

- [ ] **Step 2: Commit**

```bash
git add test/fixtures/mock-bridge.ts
git commit -m "test(calcom): add scriptable mock bridge fixture"
```

---

## Task 8: `calcom-client.ts` — single bridge gateway (TDD)

**Files:**
- Create: `src/server/calcom-client.ts`
- Test: `test/unit/calcom-client.test.ts`

- [ ] **Step 1: Write failing tests**

`hola-boss-apps/calcom/test/unit/calcom-client.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest"

import { call, setBridgeClient } from "../../src/server/calcom-client"
import { MockBridge } from "../fixtures/mock-bridge"

describe("calcom-client.call", () => {
  let bridge: MockBridge

  beforeEach(() => {
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  it("returns ok for 2xx", async () => {
    bridge.whenGet("/v2/event-types").respond(200, { status: "success", data: [{ id: 1 }] })
    const r = await call<{ data: Array<{ id: number }> }>("GET", "/event-types")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.data[0].id).toBe(1)
  })

  it("maps 400 to validation_failed with Cal.com-shaped error", async () => {
    bridge.whenPost("/v2/bookings/bk_1/cancel").respond(400, {
      status: "error",
      error: { message: "Cannot cancel past booking", code: "INVALID_STATE" },
    })
    const r = await call("POST", "/bookings/bk_1/cancel", {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("validation_failed")
      expect(r.error.message).toContain("Cannot cancel")
    }
  })

  it("maps 429 to rate_limited with retry_after", async () => {
    bridge.whenGet("/v2/bookings").respond(429, { error: "slow down" }, { "retry-after": "45" })
    const r = await call("GET", "/bookings")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited")
      expect(r.error.retry_after).toBe(45)
    }
  })

  it("maps 5xx to upstream_error", async () => {
    bridge.whenGet("/v2/event-types").respond(503, {})
    const r = await call("GET", "/event-types")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })

  it("maps 'no cal integration' thrown error to not_connected", async () => {
    bridge.whenAny().throwOnce(new Error("No cal integration configured. Connect via Integrations settings."))
    const r = await call("GET", "/event-types")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
  })

  it("maps other thrown errors to upstream_error", async () => {
    bridge.whenAny().throwOnce(new Error("ECONNREFUSED"))
    const r = await call("GET", "/event-types")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("upstream_error")
  })
})
```

- [ ] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

- [ ] **Step 3: Implement `src/server/calcom-client.ts`**

```typescript
import { createIntegrationClient } from "./holaboss-bridge"
import type { CalcomError, Result } from "../lib/types"

const CALCOM_BASE = "https://api.cal.com/v2"

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
  // Composio toolkit slug for Cal.com is "cal" (verified via docs.composio.dev/toolkits/cal).
  // All Composio action names use the CAL_* prefix — e.g. CAL_CANCEL_BOOKING_VIA_UID — which confirms
  // the slug. Do NOT change this to "calcom" / "cal-com" / "cal_com" without re-verifying.
  return createIntegrationClient("cal") as BridgeLike
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
  // The bridge SDK throws: `No ${provider} integration configured. Connect via Integrations settings.`
  // With provider="cal", the thrown message contains "no cal integration".
  return (
    msg.includes("no cal integration") ||
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
): Promise<Result<T, CalcomError>> {
  const client = getBridgeClient()
  let resp
  try {
    resp = await client.proxy<T>({
      method,
      endpoint: `${CALCOM_BASE}${endpoint}`,
      body,
    })
  } catch (e) {
    if (isNotConnectedError(e)) {
      return {
        ok: false,
        error: { code: "not_connected", message: "Cal.com is not connected for this workspace." },
      }
    }
    return {
      ok: false,
      error: { code: "upstream_error", message: e instanceof Error ? e.message : String(e) },
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
        message: "Cal.com API rate limit exceeded.",
        retry_after: parseRetryAfter(resp.headers),
      },
    }
  }
  if (resp.status >= 400 && resp.status < 500) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: extractErrorMessage(resp.data) ?? `Cal.com returned HTTP ${resp.status}.`,
      },
    }
  }
  return {
    ok: false,
    error: {
      code: "upstream_error",
      message: extractErrorMessage(resp.data) ?? `Cal.com returned HTTP ${resp.status}.`,
    },
  }
}

export const apiGet = <T>(endpoint: string) => call<T>("GET", endpoint)
export const apiPost = <T>(endpoint: string, body?: unknown) => call<T>("POST", endpoint, body)
export const apiPatch = <T>(endpoint: string, body: unknown) => call<T>("PATCH", endpoint, body)
export const apiDelete = <T>(endpoint: string) => call<T>("DELETE", endpoint)
```

- [ ] **Step 4: Run — expect pass**

```bash
pnpm test:unit
```

- [ ] **Step 5: Commit**

```bash
git add src/server/calcom-client.ts test/unit/calcom-client.test.ts
git commit -m "feat(calcom): add calcom-client bridge gateway with error mapping"
```

---

## Task 9: Tools — all 8 in one TDD batch

**Files:**
- Create: `src/server/tools.ts`
- Test: `test/unit/tools.test.ts`

Why one batch: the 8 Cal.com tools share the same pattern (one API call + one response transform). Splitting them into 5+ tasks adds overhead without discovery value. Each tool still gets its own test case; one file is fine.

- [ ] **Step 1: Write failing tests**

`hola-boss-apps/calcom/test/unit/tools.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { closeDb, getDb, resetDbForTests } from "../../src/server/db"
import { setBridgeClient } from "../../src/server/calcom-client"
import {
  getConnectionStatusImpl,
  listEventTypesImpl,
  getEventTypeImpl,
  listBookingsImpl,
  getBookingImpl,
  cancelBookingImpl,
  rescheduleBookingImpl,
  listAvailableSlotsImpl,
} from "../../src/server/tools"
import { MockBridge } from "../fixtures/mock-bridge"

describe("calcom tools", () => {
  let bridge: MockBridge
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "calcom-tools-"))
    resetDbForTests(path.join(tmp, "calcom.db"))
    getDb()
    bridge = new MockBridge()
    setBridgeClient(bridge.asClient())
  })

  afterEach(() => {
    closeDb()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("get_connection_status returns connected true when event-types probe returns 200", async () => {
    bridge.whenGet("/v2/event-types").respond(200, { status: "success", data: [{ id: 1 }, { id: 2 }] })
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.connected).toBe(true)
      expect(r.data.event_types_count).toBe(2)
    }
  })

  it("get_connection_status returns connected false on not_connected", async () => {
    bridge.whenGet("/v2/event-types").throwOnce(new Error("No cal integration configured"))
    const r = await getConnectionStatusImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.connected).toBe(false)
  })

  it("list_event_types returns mapped summaries", async () => {
    bridge.whenGet("/v2/event-types").respond(200, {
      status: "success",
      data: [
        {
          id: 101,
          slug: "30min",
          title: "30-min intro",
          lengthInMinutes: 30,
          description: "Quick intro call",
          schedulingUrl: "https://cal.com/josh/30min",
          locations: [{ type: "integrations:google:meet" }],
        },
      ],
    })
    const r = await listEventTypesImpl({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.event_types).toHaveLength(1)
      expect(r.data.event_types[0]).toMatchObject({
        id: "101",
        slug: "30min",
        title: "30-min intro",
        length_minutes: 30,
        booking_url: "https://cal.com/josh/30min",
      })
    }
  })

  it("get_event_type fetches by id", async () => {
    bridge.whenGet("/v2/event-types/101").respond(200, {
      status: "success",
      data: { id: 101, slug: "30min", title: "30-min intro", lengthInMinutes: 30, schedulingUrl: "https://cal.com/josh/30min" },
    })
    const r = await getEventTypeImpl({ event_type_id: "101" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.event_type.id).toBe("101")
  })

  it("list_bookings maps response and passes filter params", async () => {
    bridge.whenGet("/v2/bookings").respond(200, {
      status: "success",
      data: [
        {
          id: "bk_1",
          title: "30-min intro between Josh and Alice",
          start: "2026-04-20T10:00:00Z",
          end: "2026-04-20T10:30:00Z",
          status: "ACCEPTED",
          eventTypeId: 101,
          attendees: [{ name: "Alice", email: "alice@example.com", timeZone: "America/New_York" }],
          location: "https://meet.google.com/abc-defg-hij",
          meetingUrl: "https://meet.google.com/abc-defg-hij",
        },
      ],
    })
    const r = await listBookingsImpl({ status: "upcoming", limit: 20 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.bookings).toHaveLength(1)
      expect(r.data.bookings[0]).toMatchObject({
        id: "bk_1",
        start_time: "2026-04-20T10:00:00Z",
        attendees: [{ name: "Alice", email: "alice@example.com" }],
      })
    }
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.endpoint).toContain("status=upcoming")
  })

  it("get_booking fetches by id", async () => {
    bridge.whenGet("/v2/bookings/bk_1").respond(200, {
      status: "success",
      data: {
        id: "bk_1",
        title: "Intro",
        start: "2026-04-20T10:00:00Z",
        end: "2026-04-20T10:30:00Z",
        status: "ACCEPTED",
        attendees: [{ name: "Alice", email: "a@b.com" }],
      },
    })
    const r = await getBookingImpl({ booking_id: "bk_1" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.booking.id).toBe("bk_1")
  })

  it("cancel_booking posts to cancel endpoint with reason", async () => {
    bridge.whenPost("/v2/bookings/bk_1/cancel").respond(200, { status: "success", data: { id: "bk_1" } })
    const r = await cancelBookingImpl({ booking_id: "bk_1", reason: "Prospect rescheduling" })
    expect(r.ok).toBe(true)
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.method).toBe("POST")
    expect(lastCall.body).toEqual({ cancellationReason: "Prospect rescheduling" })
  })

  it("reschedule_booking posts to reschedule endpoint", async () => {
    bridge.whenPost("/v2/bookings/bk_1/reschedule").respond(200, {
      status: "success",
      data: { id: "bk_1_new" },
    })
    const r = await rescheduleBookingImpl({
      booking_id: "bk_1",
      new_start_time: "2026-04-21T14:00:00Z",
      reason: "Prospect asked",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.new_booking_id).toBe("bk_1_new")
    const lastCall = bridge.calls[bridge.calls.length - 1]
    expect(lastCall.body).toEqual({
      start: "2026-04-21T14:00:00Z",
      reschedulingReason: "Prospect asked",
    })
  })

  it("list_available_slots queries slots endpoint", async () => {
    bridge.whenGet("/v2/slots").respond(200, {
      status: "success",
      data: {
        "2026-04-20": [
          { start: "2026-04-20T10:00:00Z", end: "2026-04-20T10:30:00Z" },
          { start: "2026-04-20T11:00:00Z", end: "2026-04-20T11:30:00Z" },
        ],
      },
    })
    const r = await listAvailableSlotsImpl({
      event_type_id: "101",
      start_date: "2026-04-20",
      end_date: "2026-04-20",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.slots).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run — expect failure**

```bash
pnpm test:unit
```

- [ ] **Step 3: Implement `src/server/tools.ts`**

```typescript
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { apiGet, apiPost } from "./calcom-client"
import { wrapTool } from "./audit"
import type {
  AvailabilitySlot,
  BookingAttendee,
  BookingSummary,
  CalcomError,
  EventTypeSummary,
  Result,
  ToolSuccessMeta,
} from "../lib/types"

const CALCOM_APP_BASE = "https://app.cal.com"

function bookingDeepLink(id: string) {
  return `${CALCOM_APP_BASE}/bookings/${id}`
}
function eventTypeDeepLink(id: string) {
  return `${CALCOM_APP_BASE}/event-types/${id}`
}

function mapEventType(raw: Record<string, unknown>): EventTypeSummary {
  const locations = Array.isArray(raw.locations) ? (raw.locations as Array<Record<string, unknown>>) : []
  return {
    id: String(raw.id ?? ""),
    slug: String(raw.slug ?? ""),
    title: String(raw.title ?? ""),
    length_minutes: Number(raw.lengthInMinutes ?? raw.length ?? 0),
    description: (raw.description as string | null) ?? null,
    booking_url: String(raw.schedulingUrl ?? raw.link ?? ""),
    location_type: locations[0] ? String(locations[0].type ?? "") : null,
  }
}

function mapAttendee(raw: Record<string, unknown>): BookingAttendee {
  return {
    name: String(raw.name ?? ""),
    email: String(raw.email ?? ""),
    timezone: raw.timeZone ? String(raw.timeZone) : undefined,
  }
}

function mapBooking(raw: Record<string, unknown>): BookingSummary {
  const attendees = Array.isArray(raw.attendees)
    ? (raw.attendees as Array<Record<string, unknown>>).map(mapAttendee)
    : []
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    start_time: String(raw.start ?? raw.startTime ?? ""),
    end_time: String(raw.end ?? raw.endTime ?? ""),
    status: String(raw.status ?? ""),
    event_type_id: raw.eventTypeId != null ? String(raw.eventTypeId) : null,
    attendees,
    location: (raw.location as string | null) ?? null,
    meeting_url: (raw.meetingUrl as string | null) ?? null,
  }
}

// -------------------- Connection --------------------

// Probe strategy: call GET /event-types. If it returns 200 we are connected. We don't
// trust a /me endpoint because Cal.com v2 doesn't document one we've verified; event-types
// is the endpoint Composio's toolkit docs use for the happy path and it's fast/cheap.
export async function getConnectionStatusImpl(
  _input: Record<string, never>,
): Promise<Result<{ connected: boolean; event_types_count?: number } & ToolSuccessMeta, CalcomError>> {
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>("/event-types")
  if (r.ok) {
    return {
      ok: true,
      data: {
        connected: true,
        event_types_count: (r.data.data ?? []).length,
        result_summary: "Connection verified",
      },
    }
  }
  if (r.error.code === "not_connected") {
    return { ok: true, data: { connected: false, result_summary: "Not connected" } }
  }
  return r as unknown as Result<{ connected: boolean } & ToolSuccessMeta, CalcomError>
}

// -------------------- Event Types --------------------

export interface ListEventTypesInput {
  username?: string
}
export async function listEventTypesImpl(
  input: ListEventTypesInput,
): Promise<Result<{ event_types: EventTypeSummary[] } & ToolSuccessMeta, CalcomError>> {
  const qs = input.username ? `?username=${encodeURIComponent(input.username)}` : ""
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>(`/event-types${qs}`)
  if (!r.ok) return r
  const event_types = (r.data.data ?? []).map(mapEventType)
  return {
    ok: true,
    data: {
      event_types,
      calcom_object: "event-types",
      result_summary: `Listed ${event_types.length} event type(s)`,
    },
  }
}

export interface GetEventTypeInput { event_type_id: string }
export async function getEventTypeImpl(
  input: GetEventTypeInput,
): Promise<Result<{ event_type: EventTypeSummary } & ToolSuccessMeta, CalcomError>> {
  const r = await apiGet<{ data: Record<string, unknown> }>(`/event-types/${input.event_type_id}`)
  if (!r.ok) return r
  const event_type = mapEventType(r.data.data ?? {})
  return {
    ok: true,
    data: {
      event_type,
      calcom_object: "event-types",
      calcom_record_id: event_type.id,
      calcom_deep_link: eventTypeDeepLink(event_type.id),
      result_summary: `Fetched event type "${event_type.title}"`,
    },
  }
}

// -------------------- Bookings --------------------

export interface ListBookingsInput {
  status?: "upcoming" | "past" | "cancelled" | "recurring"
  attendee_email?: string
  limit?: number
}
export async function listBookingsImpl(
  input: ListBookingsInput,
): Promise<Result<{ bookings: BookingSummary[] } & ToolSuccessMeta, CalcomError>> {
  const params = new URLSearchParams()
  if (input.status) params.set("status", input.status)
  if (input.attendee_email) params.set("attendeeEmail", input.attendee_email)
  params.set("take", String(input.limit ?? 20))
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>(`/bookings?${params.toString()}`)
  if (!r.ok) return r
  const bookings = (r.data.data ?? []).map(mapBooking)
  return {
    ok: true,
    data: {
      bookings,
      calcom_object: "bookings",
      result_summary: `Listed ${bookings.length} booking(s)`,
    },
  }
}

export interface GetBookingInput { booking_id: string }
export async function getBookingImpl(
  input: GetBookingInput,
): Promise<Result<{ booking: BookingSummary } & ToolSuccessMeta, CalcomError>> {
  const r = await apiGet<{ data: Record<string, unknown> }>(`/bookings/${input.booking_id}`)
  if (!r.ok) return r
  const booking = mapBooking(r.data.data ?? {})
  return {
    ok: true,
    data: {
      booking,
      calcom_object: "bookings",
      calcom_record_id: booking.id,
      calcom_deep_link: bookingDeepLink(booking.id),
      result_summary: `Fetched booking ${booking.id}`,
    },
  }
}

export interface CancelBookingInput { booking_id: string; reason?: string }
export async function cancelBookingImpl(
  input: CancelBookingInput,
): Promise<Result<{ booking_id: string } & ToolSuccessMeta, CalcomError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>(
    `/bookings/${input.booking_id}/cancel`,
    { cancellationReason: input.reason ?? "Cancelled via Holaboss" },
  )
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      booking_id: input.booking_id,
      calcom_object: "bookings",
      calcom_record_id: input.booking_id,
      calcom_deep_link: bookingDeepLink(input.booking_id),
      result_summary: `Cancelled booking ${input.booking_id}`,
    },
  }
}

export interface RescheduleBookingInput {
  booking_id: string
  new_start_time: string
  reason?: string
}
export async function rescheduleBookingImpl(
  input: RescheduleBookingInput,
): Promise<Result<{ new_booking_id: string } & ToolSuccessMeta, CalcomError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>(
    `/bookings/${input.booking_id}/reschedule`,
    {
      start: input.new_start_time,
      reschedulingReason: input.reason ?? "Rescheduled via Holaboss",
    },
  )
  if (!r.ok) return r
  const raw = r.data.data ?? {}
  const newId = String(raw.id ?? input.booking_id)
  return {
    ok: true,
    data: {
      new_booking_id: newId,
      calcom_object: "bookings",
      calcom_record_id: newId,
      calcom_deep_link: bookingDeepLink(newId),
      result_summary: `Rescheduled booking ${input.booking_id} → ${newId}`,
    },
  }
}

// -------------------- Availability --------------------

export interface ListAvailableSlotsInput {
  event_type_id: string
  start_date: string
  end_date: string
  timezone?: string
}
export async function listAvailableSlotsImpl(
  input: ListAvailableSlotsInput,
): Promise<Result<{ slots: AvailabilitySlot[] } & ToolSuccessMeta, CalcomError>> {
  const params = new URLSearchParams()
  params.set("eventTypeId", input.event_type_id)
  params.set("startTime", input.start_date)
  params.set("endTime", input.end_date)
  if (input.timezone) params.set("timeZone", input.timezone)
  const r = await apiGet<{ data: Record<string, Array<{ start: string; end: string }>> }>(`/slots?${params.toString()}`)
  if (!r.ok) return r
  const slots: AvailabilitySlot[] = []
  const byDay = r.data.data ?? {}
  for (const day of Object.keys(byDay)) {
    for (const s of byDay[day] ?? []) {
      slots.push({ start: s.start, end: s.end })
    }
  }
  return {
    ok: true,
    data: {
      slots,
      result_summary: `Found ${slots.length} available slot(s) between ${input.start_date} and ${input.end_date}`,
    },
  }
}

// -------------------- Registration --------------------

export function registerTools(server: McpServer): void {
  const getConnectionStatus = wrapTool("calcom_get_connection_status", getConnectionStatusImpl)
  const listEventTypes = wrapTool("calcom_list_event_types", listEventTypesImpl)
  const getEventType = wrapTool("calcom_get_event_type", getEventTypeImpl)
  const listBookings = wrapTool("calcom_list_bookings", listBookingsImpl)
  const getBooking = wrapTool("calcom_get_booking", getBookingImpl)
  const cancelBooking = wrapTool("calcom_cancel_booking", cancelBookingImpl)
  const rescheduleBooking = wrapTool("calcom_reschedule_booking", rescheduleBookingImpl)
  const listAvailableSlots = wrapTool("calcom_list_available_slots", listAvailableSlotsImpl)

  const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] })

  server.tool(
    "calcom_get_connection_status",
    "Check whether Cal.com is connected for this workspace. Returns { connected, event_types_count }. If not connected, tell the user to connect Cal.com from the Holaboss integrations page.",
    {},
    async () => asText(await getConnectionStatus({})),
  )

  server.tool(
    "calcom_list_event_types",
    "List the user's Cal.com event types. Each event type has a slug, title, length in minutes, description, and a booking_url that prospects can use to self-book a meeting. Use this to discover what kinds of meetings the user offers (e.g. '30-min intro', '60-min demo') before sharing a booking URL.",
    {
      username: z.string().optional().describe("Filter by a specific username; defaults to the connected user"),
    },
    async (args) => asText(await listEventTypes(args)),
  )

  server.tool(
    "calcom_get_event_type",
    "Fetch a single Cal.com event type by id, returning the full details including booking URL, length, and description.",
    {
      event_type_id: z.string().describe("Cal.com event type id"),
    },
    async (args) => asText(await getEventType(args)),
  )

  server.tool(
    "calcom_list_bookings",
    "List Cal.com bookings. Use status='upcoming' to see future meetings, 'past' for completed ones, 'cancelled' for cancellations. Filter by attendee_email to find meetings with a specific prospect.",
    {
      status: z.enum(["upcoming", "past", "cancelled", "recurring"]).optional().describe("Filter by booking status"),
      attendee_email: z.string().optional().describe("Filter by a specific attendee's email"),
      limit: z.number().int().positive().max(100).optional().describe("Max results, default 20"),
    },
    async (args) => asText(await listBookings(args)),
  )

  server.tool(
    "calcom_get_booking",
    "Fetch a single Cal.com booking by id, returning start/end time, attendees, status, and meeting URL.",
    {
      booking_id: z.string().describe("Cal.com booking id"),
    },
    async (args) => asText(await getBooking(args)),
  )

  server.tool(
    "calcom_cancel_booking",
    "Cancel an existing Cal.com booking. Always supply a reason — it will be sent to the attendee in the cancellation notification email.",
    {
      booking_id: z.string().describe("Cal.com booking id to cancel"),
      reason: z.string().optional().describe("Cancellation reason, included in attendee notification"),
    },
    async (args) => asText(await cancelBooking(args)),
  )

  server.tool(
    "calcom_reschedule_booking",
    "Reschedule an existing Cal.com booking to a new start time. The new_start_time must be an ISO 8601 string with an explicit timezone offset. The prospect receives a reschedule notification with the reason.",
    {
      booking_id: z.string().describe("Cal.com booking id to reschedule"),
      new_start_time: z.string().describe("New start time, ISO 8601 with timezone, e.g. '2026-04-21T14:00:00Z'"),
      reason: z.string().optional().describe("Rescheduling reason, included in attendee notification"),
    },
    async (args) => asText(await rescheduleBooking(args)),
  )

  server.tool(
    "calcom_list_available_slots",
    "List available time slots for an event type within a date range. Use this to answer 'when am I free next week for a 30-min intro?' before sharing a booking URL.",
    {
      event_type_id: z.string().describe("Event type id to check availability for"),
      start_date: z.string().describe("Start of range, ISO 8601 (e.g. '2026-04-20' or '2026-04-20T00:00:00Z')"),
      end_date: z.string().describe("End of range, ISO 8601"),
      timezone: z.string().optional().describe("IANA timezone for slot times, e.g. 'America/New_York'"),
    },
    async (args) => asText(await listAvailableSlots(args)),
  )
}
```

- [ ] **Step 4: Run — expect pass**

```bash
pnpm test:unit
```

Expected: all tool tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tools.ts test/unit/tools.test.ts
git commit -m "feat(calcom): add 8 MCP tools with TDD coverage"
```

---

## Task 10: Connection helper + server routes

**Files:**
- Create: `src/server/connection.ts`
- Create: `src/routes/api/health.ts`, `src/routes/api/connection-status.ts`, `src/routes/api/recent-actions.ts`, `src/routes/api/upcoming-bookings.ts`, `src/routes/api/clear-feed.ts`

- [ ] **Step 1: Create `src/server/connection.ts`**

```typescript
import { apiGet } from "./calcom-client"

export interface ConnectionStatus {
  connected: boolean
  event_types_count?: number
  error?: string
}

// Probe via GET /event-types. See tools.getConnectionStatusImpl for the rationale.
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>("/event-types")
  if (r.ok) {
    return {
      connected: true,
      event_types_count: (r.data.data ?? []).length,
    }
  }
  if (r.error.code === "not_connected") {
    return { connected: false }
  }
  return { connected: false, error: r.error.message }
}
```

- [ ] **Step 2: Create `src/routes/api/health.ts`**

```typescript
import { createServerFileRoute } from "@tanstack/react-start/server"

export const ServerRoute = createServerFileRoute("/api/health").methods({
  GET: async () => {
    return new Response(JSON.stringify({ ok: true, module: "calcom" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  },
})
```

- [ ] **Step 3: Create `src/routes/api/connection-status.ts`**

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

- [ ] **Step 4: Create `src/routes/api/recent-actions.ts`**

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

- [ ] **Step 5: Create `src/routes/api/upcoming-bookings.ts`**

```typescript
import { createServerFileRoute } from "@tanstack/react-start/server"
import { listBookingsImpl } from "../../server/tools"

export const ServerRoute = createServerFileRoute("/api/upcoming-bookings").methods({
  GET: async () => {
    const r = await listBookingsImpl({ status: "upcoming", limit: 10 })
    if (r.ok) {
      return new Response(JSON.stringify({ bookings: r.data.bookings }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ bookings: [], error: r.error.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  },
})
```

- [ ] **Step 6: Create `src/routes/api/clear-feed.ts`**

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

- [ ] **Step 7: Typecheck**

```bash
pnpm run typecheck
```

If `routeTree.gen.ts` is stale, run `pnpm dev:web` briefly (Ctrl+C after HMR) or delete `src/routeTree.gen.ts` and let the next build regenerate it.

- [ ] **Step 8: Commit**

```bash
git add src/server/connection.ts src/routes/api/ src/routeTree.gen.ts
git commit -m "feat(calcom): add server routes for health, status, feed, upcoming, clear"
```

---

## Task 11: UI components

**Files:**
- Create: `src/components/connection-status-bar.tsx`, `src/components/upcoming-bookings.tsx`, `src/components/activity-feed.tsx`

- [ ] **Step 1: Create `src/components/connection-status-bar.tsx`**

```tsx
import { useEffect, useState } from "react"

interface Status {
  connected: boolean
  event_types_count?: number
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
          setStatus((await r.json()) as Status)
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
        Checking Cal.com connection…
      </div>
    )
  }

  if (status.error) {
    return (
      <div className="flex items-center justify-between border-b border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive">
        <span>Connection error: {status.error}</span>
        <a href={frontendUrl} className="underline hover:text-destructive-foreground">Retry →</a>
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="flex items-center justify-between border-b border-amber-500/40 bg-amber-500/10 px-6 py-2 text-sm">
        <span className="text-amber-700 dark:text-amber-400">
          Not connected. Open Holaboss to connect Cal.com.
        </span>
        <a href={frontendUrl} className="text-amber-700 dark:text-amber-400 underline hover:text-foreground">
          Connect Cal.com →
        </a>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-6 py-2 text-sm">
      <span className="flex items-center gap-2 text-foreground">
        <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
        Connected to Cal.com
        {typeof status.event_types_count === "number" && status.event_types_count > 0
          ? ` · ${status.event_types_count} event type${status.event_types_count === 1 ? "" : "s"}`
          : ""}
      </span>
      <a
        href="https://app.cal.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-foreground"
      >
        Open Cal.com →
      </a>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/components/upcoming-bookings.tsx`**

```tsx
import { useEffect, useState } from "react"
import type { BookingSummary } from "../lib/types"

export function UpcomingBookings() {
  const [bookings, setBookings] = useState<BookingSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch("/api/upcoming-bookings")
        if (r.ok && !cancelled) {
          const data = (await r.json()) as { bookings: BookingSummary[] }
          setBookings(data.bookings)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (loading) {
    return (
      <div className="border-b border-border px-6 py-4 text-xs text-muted-foreground">
        Loading upcoming bookings…
      </div>
    )
  }

  if (bookings.length === 0) {
    return (
      <div className="border-b border-border px-6 py-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upcoming</div>
        <div className="mt-2 text-xs text-muted-foreground">No upcoming bookings.</div>
      </div>
    )
  }

  return (
    <div className="border-b border-border px-6 py-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Upcoming · {bookings.length}
      </div>
      <ul className="space-y-2">
        {bookings.slice(0, 5).map((b) => {
          const start = new Date(b.start_time)
          const attendeeName = b.attendees[0]?.name ?? b.attendees[0]?.email ?? "—"
          return (
            <li key={b.id} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-medium text-foreground">{b.title}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {start.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                with {attendeeName}
                {b.meeting_url && (
                  <>
                    {" · "}
                    <a href={b.meeting_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      Join
                    </a>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
```

- [ ] **Step 3: Create `src/components/activity-feed.tsx`**

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
        No agent activity yet. Ask your agent to list your Cal.com bookings or share a booking URL.
      </div>
    )
  }

  return (
    <div className="px-6 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Activity</h2>
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
              a.outcome === "error" ? "border-destructive/40 bg-destructive/5" : "border-border bg-card"
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
                  {a.result_summary && <div className="mt-1 text-foreground">{a.result_summary}</div>}
                  {a.error_code && (
                    <div className="mt-1 text-destructive">
                      <span className="font-mono text-xs">{a.error_code}</span>
                      {a.error_message && <span className="ml-2">{a.error_message}</span>}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => ({ ...prev, [a.id]: !prev[a.id] }))}
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
              {a.calcom_deep_link && (
                <a
                  href={a.calcom_deep_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-primary hover:underline"
                >
                  Open in Cal.com →
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

- [ ] **Step 4: Typecheck**

```bash
pnpm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/components/
git commit -m "feat(calcom): add status bar, upcoming bookings, activity feed"
```

---

## Task 12: Main page + root layout + styles

**Files:**
- Modify: `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/styles.css`

- [ ] **Step 1: Update `src/routes/__root.tsx`**

```tsx
import { createRootRoute, Outlet } from "@tanstack/react-router"
import "../styles.css"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Cal.com · Holaboss" },
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

- [ ] **Step 2: Update `src/routes/index.tsx`**

```tsx
import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { listRecentActions } from "../server/audit"
import { ConnectionStatusBar } from "../components/connection-status-bar"
import { UpcomingBookings } from "../components/upcoming-bookings"
import { ActivityFeed } from "../components/activity-feed"
import type { AgentActionRecord } from "../lib/types"

const loadFeed = createServerFn({ method: "GET" }).handler(async () => {
  return { actions: listRecentActions({ limit: 100 }) as AgentActionRecord[] }
})

export const Route = createFileRoute("/")({
  loader: async () => loadFeed(),
  component: CalcomHome,
})

function CalcomHome() {
  const { actions } = Route.useLoaderData()
  return (
    <main className="mx-auto min-h-screen max-w-5xl">
      <header className="px-6 pt-8 pb-2">
        <h1 className="text-xl font-semibold">Cal.com</h1>
        <p className="text-sm text-muted-foreground">
          Agent activity feed · pure proxy to your Cal.com account
        </p>
      </header>
      <ConnectionStatusBar />
      <UpcomingBookings />
      <ActivityFeed initial={actions} />
    </main>
  )
}
```

- [ ] **Step 3: Replace `src/styles.css`**

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --background: oklch(0.99 0 0);
  --foreground: oklch(0.15 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.15 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.15 0 0);
  --primary: oklch(0.2 0 0);
  --primary-foreground: oklch(0.98 0 0);
  --secondary: oklch(0.96 0 0);
  --secondary-foreground: oklch(0.2 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.5 0 0);
  --accent: oklch(0.96 0 0);
  --accent-foreground: oklch(0.2 0 0);
  --destructive: oklch(0.577 0.245 27);
  --destructive-foreground: oklch(0.98 0 0);
  --border: oklch(0.92 0 0);
  --input: oklch(0.92 0 0);
  --ring: oklch(0.2 0 0);
  --radius: 0.5rem;
}

.dark {
  --background: oklch(0.15 0 0);
  --foreground: oklch(0.97 0 0);
  --card: oklch(0.2 0 0);
  --card-foreground: oklch(0.97 0 0);
  --popover: oklch(0.2 0 0);
  --popover-foreground: oklch(0.97 0 0);
  --primary: oklch(0.97 0 0);
  --primary-foreground: oklch(0.2 0 0);
  --secondary: oklch(0.24 0 0);
  --secondary-foreground: oklch(0.97 0 0);
  --muted: oklch(0.22 0 0);
  --muted-foreground: oklch(0.65 0 0);
  --accent: oklch(0.24 0 0);
  --accent-foreground: oklch(0.97 0 0);
  --destructive: oklch(0.577 0.245 27);
  --destructive-foreground: oklch(0.97 0 0);
  --border: oklch(0.26 0 0);
  --input: oklch(0.26 0 0);
  --ring: oklch(0.97 0 0);
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

- [ ] **Step 4: Typecheck + build**

```bash
pnpm run typecheck
pnpm run build
```

Expected: clean typecheck, successful build producing `.output/server/index.mjs` and `.output/start-services.cjs`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/ src/styles.css src/routeTree.gen.ts
git commit -m "feat(calcom): wire main page with status, upcoming, activity feed"
```

---

## Task 13: E2E test with mock bridge

**Files:**
- Create: `test/e2e.test.ts`

- [ ] **Step 1: Write the E2E test**

`hola-boss-apps/calcom/test/e2e.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const MCP_PORT = 13092

describe("Cal.com Module E2E", () => {
  let mcpServer: Server | null = null
  let tmp: string

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "calcom-e2e-"))
    process.env.DB_PATH = path.join(tmp, "calcom-e2e.db")

    const { startMcpServer } = await import("../src/server/mcp")
    const { setBridgeClient } = await import("../src/server/calcom-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")

    const bridge = new MockBridge()
    // Connection probe uses GET /event-types, not /me — see tools.getConnectionStatusImpl
    bridge.whenGet("/v2/event-types").respond(200, {
      status: "success",
      data: [{ id: 1, slug: "30min", title: "Intro", lengthInMinutes: 30 }],
    })
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
    expect(((await r.json()) as { status: string }).status).toBe("ok")
  })

  it("list_event_types success writes an audit row", async () => {
    const { setBridgeClient } = await import("../src/server/calcom-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { listEventTypesImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenGet("/v2/event-types").respond(200, {
      status: "success",
      data: [{ id: 1, slug: "30min", title: "Intro", lengthInMinutes: 30, schedulingUrl: "https://cal.com/josh/30min" }],
    })
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("calcom_list_event_types", listEventTypesImpl)
    const r = await wrapped({})
    expect(r.ok).toBe(true)

    const rows = listRecentActions({ limit: 10 })
    const match = rows.find((row) => row.tool_name === "calcom_list_event_types" && row.outcome === "success")
    expect(match).toBeDefined()
  })

  it("cancel_booking 400 writes an error audit row", async () => {
    const { setBridgeClient } = await import("../src/server/calcom-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { cancelBookingImpl } = await import("../src/server/tools")
    const { wrapTool, listRecentActions } = await import("../src/server/audit")

    const bridge = new MockBridge()
    bridge.whenPost("/v2/bookings/bk_past/cancel").respond(400, {
      status: "error",
      error: { message: "Cannot cancel past booking" },
    })
    setBridgeClient(bridge.asClient())

    const wrapped = wrapTool("calcom_cancel_booking", cancelBookingImpl)
    const r = await wrapped({ booking_id: "bk_past", reason: "test" })
    expect(r.ok).toBe(false)

    const rows = listRecentActions({ limit: 10 })
    const errorRow = rows.find((row) => row.outcome === "error" && row.error_code === "validation_failed")
    expect(errorRow).toBeDefined()
    expect(errorRow!.error_message).toContain("past")
  })

  it("not_connected short-circuits before bridge call", async () => {
    const { setBridgeClient } = await import("../src/server/calcom-client")
    const { MockBridge } = await import("./fixtures/mock-bridge")
    const { listEventTypesImpl } = await import("../src/server/tools")

    const bridge = new MockBridge()
    bridge.whenAny().throwOnce(new Error("No cal integration configured"))
    setBridgeClient(bridge.asClient())

    const r = await listEventTypesImpl({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not_connected")
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

- [ ] **Step 2: Run E2E**

```bash
pnpm test:e2e
```

Expected: 4 tests PASS.

- [ ] **Step 3: Run full suite**

```bash
pnpm test
```

Expected: every unit + e2e test passes.

- [ ] **Step 4: Commit**

```bash
git add test/e2e.test.ts
git commit -m "test(calcom): add E2E tests against mock bridge"
```

---

## Task 14: Dockerfile sanity + README

**Files:**
- Modify: `Dockerfile`, `README.md`

- [ ] **Step 1: Verify `Dockerfile`**

Read `hola-boss-apps/calcom/Dockerfile`. Confirm it:
1. Uses Node 20 Alpine
2. Runs `rm -rf node_modules && pnpm install --maxsockets 1 && pnpm run build`
3. Starts both web and services processes
4. Exposes 8080 and 3099

Replace any `module-template` references with `calcom`.

- [ ] **Step 2: Rewrite `README.md`**

```markdown
# Cal.com Module

A Holaboss module that gives the workspace agent Cal.com scheduling capabilities via bridge+Composio.

## What it does

Exposes 8 MCP tools for reading and managing Cal.com event types, bookings, and availability. All operations are pure proxy: Cal.com is the source of truth. The module stores only an append-only audit log (`agent_actions`) of every tool call, which powers an Activity Feed UI with a live Upcoming Bookings panel.

## Tools

| Tool | Purpose |
|------|---------|
| `calcom_get_connection_status` | Check if Cal.com is connected |
| `calcom_list_event_types` | List the user's event types (slug, duration, booking URL, description) |
| `calcom_get_event_type` | Fetch a single event type's full details |
| `calcom_list_bookings` | List bookings filtered by status (upcoming/past/cancelled) or attendee email |
| `calcom_get_booking` | Fetch a single booking's full details |
| `calcom_cancel_booking` | Cancel a booking with a reason |
| `calcom_reschedule_booking` | Reschedule a booking to a new start time |
| `calcom_list_available_slots` | Check free slots for an event type within a date range |

## Architecture

Pure proxy via bridge + Composio. No local business data. Single SQLite audit log table. Same structural shape as the `attio` module. See `docs/superpowers/plans/2026-04-15-calcom-module.md` for the full plan.

## Development

```bash
pnpm install --maxsockets 1
pnpm run dev          # start web + MCP + services
pnpm test             # run unit + e2e (mock bridge)
pnpm run build        # production build
```

## Environment variables

- `HOLABOSS_APP_GRANT` — workspace grant token (set by sandbox runtime)
- `HOLABOSS_INTEGRATION_BROKER_URL` — broker URL (set by sandbox runtime)
- `HOLABOSS_FRONTEND_URL` — frontend URL for the "Connect Cal.com" link
- `DB_PATH` — SQLite file path (default: `./data/calcom.db`)
- `PORT` / `MCP_PORT` — web / MCP server ports
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile README.md
git commit -m "docs(calcom): add module README and verify Dockerfile"
```

---

## Task 15: Production build + final smoke

**Files:** (none new)

- [ ] **Step 1: Clean build**

```bash
cd /Users/joshua/holaboss-ai/holaboss/hola-boss-apps/calcom
rm -rf .output dist
pnpm run build
```

- [ ] **Step 2: Full test suite**

```bash
pnpm test
```

- [ ] **Step 3: Typecheck + lint**

```bash
pnpm run typecheck
pnpm run lint
```

- [ ] **Step 4: Local boot smoke**

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
- `/api/health` → `{"ok":true,"module":"calcom"}`
- `/api/connection-status` → `{"connected":false}` or error (no real bridge)
- `/mcp/health` → `{"status":"ok"}`

Stop with Ctrl+C.

- [ ] **Step 5: Push**

```bash
git status  # should be clean
git log --oneline -20
git push -u origin HEAD
```

---

## Task 16: Workspace integration smoke (manual, deferred)

Validation gate, not a code task. Runs once the module is deployed into a Holaboss workspace.

- [ ] **Step 1: Install into a Holaboss workspace with Cal.com connected**

- [ ] **Step 2: Run a real SDR flow combining Attio + Gmail + Cal.com**

Ask the agent:
1. "Find John Smith in my Attio CRM" → `attio_find_people`
2. "What event types do I have in Cal.com?" → `calcom_list_event_types`
3. "Draft an email introducing myself and include my 30-min intro booking link" → `gmail_create_draft` + inline booking_url from previous step
4. "Show me my upcoming meetings this week" → `calcom_list_bookings { status: 'upcoming' }`
5. After the prospect self-books: "Add a note to John's Attio record that we have a meeting on Friday" → `attio_add_note` with the booking details

Expected:
- Every operation appears in the appropriate module's Activity Feed within 3s
- The booking URL shared via gmail actually works end-to-end (prospect can book)
- No agent-originated write touches the user's real Cal.com bookings (only read + cancel/reschedule of existing)

- [ ] **Step 3: Record demo video**

Capture the cross-module flow — Attio + Gmail + Cal.com windows side by side — for the SDR scenario demo asset.

---

## Self-Review

**Decision coverage:** every decision in the "Up-front Design Decisions" table is realized in a specific task.
- #1 (name) → Task 1 + all file names/prefixes
- #2 (pure proxy) → Tasks 2, 8, 9 (no local business data anywhere)
- #3 (single table) → Task 2 db.ts, Task 5 tests
- #4 (bridge+Composio, provider slug `cal`) → Task 0 spike (now with verified Composio support), Task 8 `calcom-client.ts` `createIntegrationClient("cal")`
- #5 (typed tools) → Task 3 types.ts + Task 9 tools.ts
- #6 (read + cancel/reschedule only, no create booking) → Task 9 tool set explicitly excludes `create_booking`; non-goal documented in upfront decisions
- #7 (UI: status + upcoming + feed) → Tasks 10, 11, 12
- #8 (brand color) → Task 3 MODULE_CONFIG, Task 12 styles.css
- #9 (4-code error mapping) → Task 8 `calcom-client.ts` + tests
- #10 (mock bridge tests, no live CI) → Tasks 7, 9, 13
- #11 (API shape verification during spike) → Task 0 explicit step

**Placeholders:** none. Every code step shows complete, copy-pasteable code.

**Type consistency:**
- `Result<T, CalcomError>` used consistently across `calcom-client`, `tools`, `audit`, `connection`
- `ToolSuccessMeta` fields in `audit.ts` match the optional properties in `types.ts`
- `AgentActionRecord` column names match `db.ts` schema verbatim
- Tool impl names (`getConnectionStatusImpl`, `listEventTypesImpl`, ...) match registrations in `registerTools` and test imports 1:1
- `MODULE_CONFIG.brandColor` matches `--primary` in styles.css

**Scope sanity:** 16 tasks, single implementation plan, ~3-5 person-days total for a single developer (faster than Attio because Cal.com's schema is fixed and there's no dynamic attribute system to model). Spike gate is 0.5d; core code 2-3d; UI + tests + polish 1d.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-15-calcom-module.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with review checkpoints between tasks. Best fit because each task is cohesive, TDD-driven, and small.

**2. Inline Execution** — Execute tasks in this session using the executing-plans skill, batch execution with user-approved checkpoints.

**Which approach?**
