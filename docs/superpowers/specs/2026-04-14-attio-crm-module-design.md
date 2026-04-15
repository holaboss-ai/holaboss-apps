# Attio Module — Design Spec

**Date**: 2026-04-14
**Status**: Brainstormed, pending plan
**Module path (target)**: `hola-boss-apps/attio/`
**Repository**: `hola-boss-apps` (independent sibling repo)
**Scenario**: SDR / sales pipeline (first of several CRM-family modules)

---

## 1. Goals, Scope, Non-Goals

### Goal

Add a new independent module `attio` to `hola-boss-apps/` that gives workspace agents full CRM capability against the user's own Attio workspace, with zero OAuth complexity (via bridge + Composio) and full respect for the user's custom Attio schema.

### In scope (v1)

- **14 MCP tools** (extended SDR MVP + schema description) — covers People, Companies, Notes, Tasks, Lists
- **Pure proxy architecture** — business data source of truth is Attio; module stores no local copy of contacts/deals
- **One local SQLite table**: `agent_actions` — append-only audit log of every tool invocation, powering the module's observable Activity Feed
- **Web UI with three regions**: connection status bar, search shortcut, activity feed
- **Bridge/Composio integration** via `createIntegrationClient("attio").proxy(...)`, no per-provider auth code in the module
- **Dynamic attribute support** — tools accept `Record<string, unknown>` and rely on a `describe_schema` tool for agent to discover available fields (including custom ones)

### Out of scope (v1)

- Local caching of Attio business data (people, companies, deals)
- Draft / review gate before writing to Attio
- Creating or modifying Attio object definitions / attribute schemas (schema is read-only)
- Comments, Threads, workspace-member management
- CSV / HubSpot / Pipedrive import
- Webhooks (Attio → module push)
- Calendar, email follow-ups (separate module, next spec)
- Undo functionality (the Activity Feed is the manual-undo aid; the real undo happens in Attio's own UI)
- Multi-tenant / multi-workspace switching (each Holaboss workspace has one Attio binding, one-to-one)
- CRUD on custom Attio objects beyond People / Companies / Deals (see §8.4)

---

## 2. Architecture

### Position in the system

```
 Workspace Agent (holaOS runtime)
        │  MCP over SSE
        ▼
 ┌─────────────────────────────────────────────┐
 │  attio module (hola-boss-apps/attio)        │
 │                                             │
 │  ┌──────────────┐   ┌─────────────────┐     │
 │  │ MCP Server   │   │ Web App (TSR)   │     │
 │  │ :13100+      │   │ :18080+         │     │
 │  │ attio_*      │   │  - Activity feed│     │
 │  │ (14 tools)   │   │  - Search       │     │
 │  └──────┬───────┘   │  - Conn status  │     │
 │         │           └────────┬────────┘     │
 │         │                    │              │
 │         ▼                    ▼              │
 │  ┌─────────────────────────────────┐        │
 │  │  src/server/attio-client.ts     │        │
 │  │  (single bridge gateway)        │        │
 │  └──────┬──────────────────────────┘        │
 │         │                                   │
 │         │  ┌─────────────────────────┐      │
 │         │  │ SQLite (1 table)        │      │
 │         │  │  agent_actions          │      │
 │         │  └─────────────────────────┘      │
 │         ▼                                   │
 └─────────│───────────────────────────────────┘
           │ createIntegrationClient("attio")
           ▼
 ┌─────────────────────────────────────────────┐
 │  In-sandbox Integration Broker (:8080)      │
 │  /api/v1/integrations/broker/proxy          │
 │  (holaOS/runtime/api-server)                │
 └──────────────────┬──────────────────────────┘
                    │ grant + workspace binding
                    ▼
            Composio → Attio API
                    │
                    ▼
             https://api.attio.com/v2/*
```

### Component list

| Component | Path | Purpose |
|-----------|------|---------|
| **MCP server** | `src/server/mcp.ts` | Defines and dispatches the 14 `attio_*` tools. Each tool is a thin wrapper that calls `attio-client` and is decorated by `wrapTool()`. Contains no business logic. |
| **Attio client** | `src/server/attio-client.ts` | **Single allowed gateway** to bridge. Wraps `createIntegrationClient("attio")` with typed `get/post/patch/delete` methods. Centralizes error-code mapping (`not_connected` / `rate_limited` / `validation_failed` / `upstream_error`). Tools must not call `bridge.proxy` directly. |
| **Audit** | `src/server/audit.ts` | `wrapTool(name, fn)` higher-order function. Writes an `agent_actions` row for every tool invocation (success or failure), with args snapshot, duration, result summary, and (on success) deep link. |
| **Database** | `src/server/db.ts` | SQLite bootstrap, single-table migration, indexes. Uses `better-sqlite3`. |
| **Connection status** | `src/server/connection.ts` | Exposes `GET /api/connection-status` by asking bridge whether a valid Attio connection exists for this workspace. |
| **Routes** | `src/routes/index.tsx`, `src/routes/api/*` | TanStack Router entries: `/` (feed + search + status bar), `/api/health`, `/api/connection-status`, `/api/recent-actions`, `/api/search`, `/api/clear-feed`. |
| **Types** | `src/lib/types.ts` | `AgentActionRecord`, `AttioRecord`, `AttioErrorCode`, `PlatformConfig`. |
| **Styles** | `src/styles.css` | Tailwind + OKLch theme; brand primary `oklch(0.61 0.22 275)` (Attio purple-blue). |

### Two processes (inherited from `_template`)

- **Web process** (Vite) — TanStack Start SSR; port dynamically assigned by runtime from `18080+` range
- **Services process** (tsx) — MCP server over SSE; port dynamically assigned from `13100+` range
- **No job queue worker** — pure proxy has no async work; remove the `queue.ts` worker code from the template when copying

### Three canonical data flows

**A. Agent write (most common)**
```
Agent → MCP tool (attio_create_person)
      → audit.wrapTool starts timer
      → attio-client.post("/v2/objects/people/records", { values: attrs })
      → bridge.proxy(...) → Composio → Attio
      → success: tool returns { record_id, record_url }; audit writes outcome=success
      → failure: tool returns structured error; audit writes outcome=error + error_code
```

**B. Agent reads schema**
```
Agent → attio_describe_schema()
      → attio-client.get("/v2/objects") + attribute lookups per object
      → merged JSON returned to agent
      → no audit row (schema is a read-only inspection, not a mutation)
```

**C. Web UI mount**
```
Browser → /
        → SSR reads agent_actions ORDER BY timestamp DESC LIMIT 100
        → server functions query connection status
        → client polls /api/connection-status + /api/recent-actions every 3–5s
        → re-render on connection or feed delta
```

### Isolation and failure boundaries

- MCP server and Web app run as separate processes; shared state is the SQLite file (`/app/data/attio.db`) and bridge config via env vars
- SQLite is single-writer by nature; no WAL tuning required for v1
- Bridge outage → all tools return `upstream_error`, connection status bar turns red, Activity Feed remains readable (historical data untouched)
- Attio outage → same as above; 429 maps to `rate_limited` + `retry_after`

---

## 3. Data Model

### Local SQLite: single table

```sql
CREATE TABLE agent_actions (
  id              TEXT PRIMARY KEY,        -- uuid v7 (sortable)
  timestamp       INTEGER NOT NULL,        -- unix ms, default now
  tool_name       TEXT NOT NULL,           -- e.g. "attio_create_person"
  args_json       TEXT NOT NULL,           -- JSON-stringified input snapshot
  outcome         TEXT NOT NULL,           -- 'success' | 'error'
  duration_ms     INTEGER NOT NULL,        -- tool execution time
  -- success columns
  attio_object    TEXT,                    -- 'people' | 'companies' | 'deals' | null
  attio_record_id TEXT,                    -- Attio record id
  attio_deep_link TEXT,                    -- https://app.attio.com/...
  result_summary  TEXT,                    -- human-readable, e.g. "Created person 'Alice Chen'"
  -- error columns
  error_code      TEXT,                    -- 'not_connected' | 'rate_limited' | 'validation_failed' | 'upstream_error'
  error_message   TEXT                     -- Attio's message or bridge error
);

CREATE INDEX idx_agent_actions_timestamp ON agent_actions (timestamp DESC);
CREATE INDEX idx_agent_actions_tool ON agent_actions (tool_name, timestamp DESC);
```

### Semantics

- **Append-only**. No `UPDATE`, no per-row `DELETE`. The only `DELETE` is the user-triggered "Clear feed" button, which wipes the entire table.
- **Args are not redacted**. If the agent passes emails / phones, they are stored verbatim. This is the standard behavior for an audit log; do not treat it as a defect.
- **No joined / cached Attio data**. Any "what does this person look like now?" answer must come from Attio via deep link. The module never mirrors business entities.
- **No automatic retention policy in v1**. Users can wipe manually; add retention only if the database grows problematically.
- **No workspace_id / user_id column**. The module DB belongs to a single sandbox-isolated workspace; multi-tenancy is not a concern here.

### External Attio schema: not materialized

No TypeScript interface for `AttioPerson`, `AttioCompany`, etc. The only shape the code knows is:

```typescript
type AttioRecord = {
  id: string
  values: Record<string, unknown>
}
```

The agent discovers available attributes at runtime via `attio_describe_schema`. This is the intentional consequence of choosing dynamic attributes over hardcoded fields.

---

## 4. MCP Tool Surface (14 tools)

All tools prefixed `attio_`. All return `{ ok: boolean, data?: T, error?: { code, message, retry_after? } }`.

### 4.1 Schema & connection (2)

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `attio_describe_schema` | `{ objects?: string[] }` (default `["people","companies","deals"]`) | `{ objects: Array<{ slug, plural_name, attributes: Array<{ slug, title, type, is_required, is_unique, options? }> }> }` | Agent calls this before doing work to learn the workspace schema. **Not audit-logged** (inspection, not mutation). |
| `attio_get_connection_status` | `{}` | `{ connected: boolean, workspace_name?: string }` | Primarily for the web UI; agent may call when it needs to prompt the user to connect. |

### 4.2 People (4)

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `attio_find_people` | `{ query: string, limit?: number }` (default limit=20) | `{ records: AttioRecord[] }` | Maps to Attio `POST /v2/objects/people/records/query` with a compound filter (`name contains query OR email_addresses contains query`). See §8.5. |
| `attio_get_person` | `{ record_id: string }` | `{ record: AttioRecord }` | Full record with all attribute values. |
| `attio_create_person` | `{ attributes: Record<string, unknown> }` | `{ record_id, record_url }` | Attributes pass-through per schema. No field-level validation in module; Attio's 4xx is surfaced as `validation_failed`. |
| `attio_update_person` | `{ record_id: string, attributes: Record<string, unknown> }` | `{ record_id, record_url }` | `PATCH` semantics — only supplied fields are modified. Omitted fields remain untouched. |

### 4.3 Companies (3)

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `attio_find_companies` | `{ query: string, limit?: number }` | `{ records: AttioRecord[] }` | Same pattern as `find_people`. |
| `attio_create_company` | `{ attributes: Record<string, unknown> }` | `{ record_id, record_url }` | — |
| `attio_link_person_to_company` | `{ person_id: string, company_id: string }` | `{ ok: true }` | Implemented by updating the person's `company` reference attribute. Attio stores the relationship as a reference field, not a join table. |

### 4.4 Notes (1)

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `attio_add_note` | `{ parent_object: 'people'\|'companies'\|'deals', parent_record_id: string, title: string, content: string }` | `{ note_id, note_url }` | Attio notes are standalone objects attached to any parent record. Merged into one tool to keep total count manageable. Tool description must enumerate the three valid `parent_object` values and give examples per type so the agent picks correctly. |

### 4.5 Tasks (2)

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `attio_create_task` | `{ content: string, deadline_at?: string (ISO 8601 with timezone), assignee?: string (workspace member id), linked_records?: Array<{ object: string, record_id: string }> }` | `{ task_id }` | Attio tasks are workspace-level objects; can be linked to multiple records. Deadline must include timezone suffix — enforce in tool description. |
| `attio_list_tasks` | `{ filter?: { assignee?: string, status?: 'open'\|'completed', linked_record?: { object, record_id } }, limit?: number }` | `{ tasks: Array<{ id, content, deadline_at, is_completed, linked_records }> }` | Powers "what's on my plate" agent flows. |

### 4.6 Lists / pipelines (2)

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `attio_list_records_in_list` | `{ list_id: string, limit?: number }` | `{ entries: Array<{ entry_id, record_id, parent_object, entry_values }> }` | Returns list members along with **list-level entry attributes** (stage, deal value, etc.), which differ from the parent record's attributes. See §8.2. |
| `attio_add_to_list` | `{ list_id: string, record_id: string, parent_object: 'people'\|'companies'\|'deals', entry_values?: Record<string, unknown> }` | `{ entry_id }` | **Merged "add" and "move stage" semantics**: if the record is already in the list, falls through to an update of `entry_values`; otherwise creates a new entry. This is a conscious v1 compromise to stay under 15 tools. A separate `attio_move_list_entry` may be added in v2 if the merged semantics confuse the agent. |

### 4.7 Count

```
Schema:    describe_schema, get_connection_status                            2
People:    find_people, get_person, create_person, update_person             4
Companies: find_companies, create_company, link_person_to_company            3
Notes:     add_note                                                          1
Tasks:     create_task, list_tasks                                           2
Lists:     list_records_in_list, add_to_list                                 2
                                                                         ─────
                                                                            14
```

---

## 5. Web UI

Single-route module. Path `/` renders everything; no sub-pages. Three vertical regions.

### 5.1 Top: connection status bar (fixed)

| State | Appearance | Action |
|-------|-----------|--------|
| Connected | Single line "Connected to Attio · {workspace_name}", green dot left, "Open Attio →" button right | Button opens `https://app.attio.com` |
| Not connected | Orange bar "Not connected. Open Holaboss to connect Attio →" | Button opens `HOLABOSS_FRONTEND_URL` (env) + fallback copy |
| Connection error | Red bar "Connection error: {message} · Retry" | Same target as "Not connected" |

**Polling**: client polls `/api/connection-status` every 5 seconds; also triggers an immediate refresh on window focus to avoid showing stale state after tab-switch.

### 5.2 Middle: search shortcut

- Large search input, placeholder: `Search people or companies in Attio…`
- 300ms debounce on change → server function → fans out to `attio_find_people` + `attio_find_companies` in parallel (limit 10 each)
- Results render as two columns — **People** / **Companies** — each a card with name, primary attribute (email / domain), and "Open in Attio →" link
- Clicking a card jumps directly to Attio deep link; **no in-module detail view**
- **No "Create" button** in UI — creation is the agent's job, not a manual form
- Value: helps the user confirm which "Alice" the agent referenced without tabbing away

### 5.3 Main: Activity Feed (the star)

- Reverse-chronological list; initial SSR render of the most recent 100 `agent_actions`
- Row structure:
  ```
  [icon]  [10:42 AM]  attio_create_person
          Created person "Alice Chen" · Acme Corp
          args: { name: "Alice Chen", email: "alice@acme.com", ... } ▸
          [Open in Attio →]
  ```
- **Icons**: green ✓ (success), red ✗ (error). `describe_schema` calls are not rendered.
- **`result_summary`** is the human-readable line, generated in the tool implementation at call time
- **`args_json`** is collapsed by default; click `▸` to expand pretty-printed JSON; click outside to collapse
- **Failed rows** get a light red background and show `error_code` + `error_message` inline
- **Live refresh**: client polls `/api/recent-actions?since={last_id}` every 3 seconds; new rows prepend with a soft opacity fade-in (no lift / shadow animation)
- **Empty state**: `No agent activity yet. Ask your agent to find or create a person in Attio.`
- **Clear feed**: secondary button in top-right; two-click confirm; issues `DELETE FROM agent_actions`

### 5.4 Server routes

```
GET  /                        → SSR activity feed (reads DB + initial conn status)
GET  /api/health              → { ok: true, module: "attio" }
GET  /api/connection-status   → { connected, workspace_name?, error? }
GET  /api/recent-actions      → ?since=<id> | ?limit=<n>
POST /api/search              → proxies find_people + find_companies
POST /api/clear-feed          → truncates agent_actions (with confirmation guarded in UI)
```

All API endpoints implemented via `createServerFn` from `@tanstack/react-start`, except `/api/health` which is a plain route for sandbox healthcheck.

### 5.5 UI conventions (from `hola-boss-apps/CLAUDE.md`)

- TanStack Start SSR, file-based routing (`routeTree.gen.ts` auto-generated)
- Tailwind + OKLch CSS variables; brand base color is Attio's signature near-black `oklch(0.248 0.006 270)` (converted from the supplied `lab(12.7212% 0.103362 -2.22102)`, sRGB equivalent `#1F2024`). See §10 for how this maps to light/dark `--primary`.
- shadcn/ui `button` and `card` only; all other visuals Tailwind-composed
- Inter + Newsreader font pairing
- **Forbidden**: gradient backgrounds, `hover:shadow-*`, `hover:-translate-*`, `transition-all`, opacity hacks on design tokens — enforced by project rules

### 5.6 Explicitly out

- Login / multi-tenant UI
- Settings page (`app.runtime.yaml` is the config)
- Person / company / deal detail pages
- Pipeline board visualization
- CSV export of the feed
- Manual record-creation forms

---

## 6. Error Handling

### 6.1 Error code enum

Four codes cover every failure surface:

| Code | Trigger | Agent behavior (documented in tool description) | HTTP mapping |
|------|---------|-----------------------------------------------|--------------|
| `not_connected` | Bridge reports no connection / Composio binding missing | Tell user to connect Attio in Holaboss; do not retry | — |
| `rate_limited` | Attio or bridge returns 429 | Respect `retry_after`; agent decides whether to wait | 429 |
| `validation_failed` | Attio returns 4xx (400 / 404 / 422) | Read the passed-through message and adjust inputs | 400-422 |
| `upstream_error` | Attio 5xx / bridge self-failure / network timeout | Do not retry; inform user of upstream problem | 500+ |

### 6.2 Centralized mapping in `attio-client.ts`

All error classification happens in one place. Pseudocode:

```typescript
async function call<T>(method, endpoint, body?): Promise<Result<T, AttioError>> {
  try {
    const resp = await bridge.proxy({ method, endpoint, body })
    if (resp.status >= 500) return err('upstream_error', resp)
    if (resp.status === 429) return err('rate_limited', resp, { retry_after: parseRetryAfter(resp) })
    if (resp.status >= 400) return err('validation_failed', resp)
    return ok(resp.data as T)
  } catch (e) {
    if (isNotConnectedError(e)) return err('not_connected', e)
    return err('upstream_error', e)
  }
}
```

Tool implementations never use `try/catch` around Attio calls; they destructure the `Result` and propagate.

### 6.3 Tool return format

```typescript
// success
{ ok: true, data: { record_id, record_url } }

// failure
{
  ok: false,
  error: {
    code: 'validation_failed',
    message: 'Attribute "industry" requires one of: SaaS, Services, Manufacturing',
    retry_after: undefined  // populated only for rate_limited
  }
}
```

Conventions:
- `message` passes through Attio's raw error string. LLMs read these directly; re-wrapping only adds noise.
- Failures are still written to `agent_actions` (`outcome='error'`) so the Activity Feed shows them.
- **No silent retries**. 429s and network failures return immediately; the agent decides whether to try again.
- **Exception**: `not_connected` short-circuits before any bridge call to avoid a wasted round-trip.

### 6.4 UI presentation of errors

- **Connection status bar** owns connection-level errors (not_connected, bridge unreachable, Composio rejection)
- **Activity Feed** row backgrounds show individual tool failures
- **Search input** displays inline "Search failed · retry" on failure
- **No toast / notification system** — the feed and status bar together are sufficient; toasts would add noise

### 6.5 Crash recovery

- MCP server crash → sandbox runtime restarts it via `lifecycle.start` + healthcheck
- SQLite integrity failure → on boot, run `PRAGMA integrity_check`; on failure, rename `attio.db` → `attio.db.corrupt.{ts}` and recreate an empty table (losing the feed is better than losing the module)
- Bridge unreachable on boot → do not fail startup; connection status bar will reflect the state, tool calls will return `upstream_error`

---

## 7. Testing Strategy

### 7.1 Unit tests (Vitest)

- `attio-client.test.ts` — mocks `bridge.proxy`, verifies all 5 status-code paths map to the right `AttioErrorCode` (success / 400 / 429 / 500 / network-throw)
- `audit.test.ts` — verifies `wrapTool()` writes correct rows on both success and error paths (all columns populated, `duration_ms` plausible)
- `mcp-tools.test.ts` — one test per tool, mocks the `attio-client` layer, asserts the input-to-endpoint-and-body transformation and the return shape

### 7.2 Integration tests (Vitest + real SQLite)

- Real `better-sqlite3` with a temp-file DB
- Real MCP server instance (handler level, no HTTP)
- `bridge.proxy` mocked per scripted fixture
- Key scenarios:
  - `create_person` success → `agent_actions` has one success row
  - `create_person` returns 422 → tool returns `validation_failed`, audit row has `outcome='error'`
  - While disconnected, `create_person` returns `not_connected` and bridge is never invoked
  - After `clear-feed`, the table is empty and subsequent tool calls still append correctly

### 7.3 E2E tests (Playwright)

- Launch the web process + MCP process via `npm run dev`
- **Mock bridge** is a local Fastify server loaded from `test/fixtures/mock-bridge.ts`; never touches real Attio
- Target ~13 scenarios (mirroring existing modules' e2e budget):
  - `/` renders empty state
  - Simulated agent call to `create_person` → feed shows new row within 3s
  - Bridge returning `not_connected` → status bar turns orange
  - Search input → bridge returns 2 people → UI renders cards
  - `Clear feed` empties the list
  - etc.

**Not running tests against live Attio** is a deliberate v1 choice: CI stability + offline dev loop trump "schema drift detection." A separate, opt-in `test/smoke-live.test.ts` may be introduced later and gated behind `ATTIO_LIVE_TEST=1`, executed on-demand (not in main CI).

### 7.4 Shared test helper

New file: `test/fixtures/mock-bridge.ts`:

```typescript
mockBridge.whenPost('/v2/objects/people/records').respond(200, { data: { id: 'rec_abc' }})
mockBridge.whenPost('/v2/objects/people/records').respondOnce(429, {...}, { 'retry-after': '30' })
mockBridge.whenAny().respond(500, ...)
```

Used by both integration and E2E tests to avoid per-test bespoke mocks.

---

## 8. Open Questions & Known Risks

### 8.1 Attio support in Composio — HIGH RISK, VERIFY FIRST

Bridge's Composio mode is theoretically provider-agnostic, but Attio-specific coverage is unverified. Before writing any tool code, run a spike:

1. Attempt to connect Attio via the Holaboss frontend integrations page
2. Confirm Composio has an Attio connector and that its OAuth scopes cover read/write on People, Companies, Deals, Lists, Tasks, Notes
3. Make the simplest call — `GET /v2/objects` — through `bridge.proxy("attio", ...)` and confirm success

**Fallback paths if the spike fails:**

- **Path A**: Request Composio to add / expand Attio connector — uncertain timeline
- **Path B**: Add a direct-OAuth mode for Attio to bridge (`authMode: "oauth"`), mirroring the existing twitter/linkedin pattern. This sacrifices the zero-auth-code elegance but is fully within Holaboss's control. Extra work: OAuth app registration, client secret storage, refresh handler

No tool implementation happens before the spike succeeds.

### 8.2 Attio List data model nuances

- Attio list entries have two attribute families: parent-record attributes (read-only) and list-entry attributes (writable, e.g. stage, deal value)
- `attio_add_to_list` / `attio_list_records_in_list` operate on **list-entry attributes only**, not parent record attributes
- The tool description must state this clearly so the agent understands the distinction
- If the target list defines no entry attributes, `entry_values` is effectively a no-op. Records can still be added; staging just isn't available.

### 8.3 Rate limit boundaries — unknown in practice

- Attio documents rate limits at a "per-second" granularity, but the Composio middle-layer may impose its own
- v1 policy: do not throttle; pass 429 through as `rate_limited` with `retry_after` and let the agent handle it
- If real usage shows frequent 429s disrupting agent runs, v2 adds a client-side token-bucket throttle

### 8.4 Custom Attio objects

- Users can create objects beyond People / Companies / Deals (e.g. Investors, Candidates, Projects)
- v1 `describe_schema` defaults to `["people", "companies", "deals"]` but accepts an `objects` array for exploration
- All specialized tools (`create_person`, `find_companies`, etc.) are hardcoded to the core three object slugs. **v1 does not CRUD custom objects.**
- v2 can add generic tools: `attio_find_records(object, query)` and `attio_create_record(object, attributes)`. Not done in v1 to avoid premature abstraction.

### 8.5 Search semantics

- Attio's `/v2/objects/:object/records/query` is a structured filter, not full-text search
- The module's `find_people(query)` internally builds a compound filter along the lines of `name contains query OR email_addresses contains query`
- The translation lives in one helper in `attio-client.ts`: `buildFuzzyQuery(query)`, covered by its own unit test
- Free-text queries like `"Alice from last week's demo"` will return nothing useful. The fix is agent prompt discipline (search by name or email), not a smarter filter.

### 8.6 Timezones and timestamps

- `agent_actions.timestamp` stored as UTC unix-ms; UI renders with `new Date(ts).toLocaleString()` in the browser's local timezone
- Attio `deadline_at` requires ISO 8601 with timezone; document this in the `attio_create_task` tool description so the agent passes an explicit offset

---

## 9. Implementation Path (skeleton)

Detailed per-file steps are the job of the writing-plans phase. This skeleton exists only to validate the overall order.

1. **Spike**: verify Composio + Attio (§8.1). Abort and reconsider before touching tool code if the spike fails.
2. **Copy `_template/` → `attio/`**. Remove publisher, queue, post-state-machine code.
3. **Rename identifiers**: `package.json`, `app.runtime.yaml`, `__root.tsx`, `api/health`, `docker-compose.yml`, `styles.css` (brand color).
4. **Implement `attio-client.ts`** — pure proxy wrapper + error mapping + unit tests.
5. **Implement `db.ts` + `audit.ts`** — single-table migration, `wrapTool()` HOF + unit tests.
6. **Implement 14 MCP tools** via `attio-client` + `wrapTool` + integration tests.
7. **Implement Web UI**: connection status bar → Activity Feed → search shortcut → clear button.
8. **Implement 4 server routes** (`connection-status`, `recent-actions`, `search`, `clear-feed`).
9. **Mock bridge fixture + E2E tests** (§7.3).
10. **End-to-end integration**: install the `attio` module in a real Holaboss workspace and run the SDR scenario (LinkedIn lead → create person → add note → create task) end-to-end; record a demo video.

**Estimate**: spike 0.5d, core code 3–4d, UI 1–2d, tests 1d, integration + polish 1d. **Total ~7–9 person-days** for a single developer, contingent on §8.1 succeeding.

---

## 10. Module Metadata

- **Name**: `attio`
- **Directory**: `hola-boss-apps/attio/`
- **MCP tool prefix**: `attio_`
- **Brand base color**: `oklch(0.248 0.006 270)` — Attio's signature near-black, converted from the official `lab(12.7212% 0.103362 -2.22102)` (sRGB `#1F2024`, rgb(31, 32, 36)). This is a very dark color with almost no chroma (C = 0.006) and a subtle cool cast (h ≈ 270°)
- **Color token mapping** (because the brand base is itself dark, we cannot use it as `--primary` unchanged in dark mode — buttons would disappear into the background):
  - **Light mode** — `--primary: oklch(0.248 0.006 270)` (brand base, used for primary buttons, focus rings, active links); `--primary-foreground: oklch(0.98 0 0)` (near-white text on primary)
  - **Dark mode** — `--primary: oklch(0.97 0.004 270)` (near-white mirror of the brand base, preserving the cool hue); `--primary-foreground: oklch(0.248 0.006 270)` (brand-black text on the inverted primary)
  - **Both modes** — `--ring` uses the mode's `--primary` value for focus indication
  - **Both modes** — `--background`, `--foreground`, `--card`, `--border`, `--muted` etc. follow the existing shadcn neutral palette; the brand only affects `--primary` and `--ring`
- **Rationale**: this inversion pattern (dark brand → near-white in dark mode) is the standard way to ship a "black brand identity" like Attio's or Vercel's; it preserves brand recognition in the static assets (logo, splash) while keeping interactive elements usable
- **Dependencies**: TanStack Start, `better-sqlite3`, `@modelcontextprotocol/sdk`, Tailwind, shadcn. **Note on bridge**: the module does not depend on an `@holaboss/bridge` npm package. Instead, like every other module in `hola-boss-apps/`, it ships a module-local `src/server/holaboss-bridge.ts` file (copied verbatim from `_template/src/server/holaboss-bridge.ts`) that exports `createIntegrationClient(provider)`. The "single bridge gateway" referenced throughout §2 and §6 is `src/server/attio-client.ts`, which is the only place that imports from `./holaboss-bridge`.
- **Required env vars at runtime**:
  - `HOLABOSS_APP_GRANT` — set by sandbox runtime
  - `HOLABOSS_INTEGRATION_BROKER_URL` — set by sandbox runtime (default derived from port)
  - `HOLABOSS_FRONTEND_URL` — used by the "Not connected" bar to link back to the Holaboss integrations page (fallback: static text)
- **Healthcheck**: `GET /api/health` (web process) and `GET /mcp/health` (services process) — standard sandbox convention
- **Data storage**: `/app/data/attio.db` (same as other modules), mounted as `module-data` volume in Docker
