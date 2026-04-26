# Holaboss App Development Guide

A concrete playbook for building a new module under `hola-boss-apps/`. Geared at the next four modules in the pipeline — **Apollo, ZoomInfo, Instantly, HubSpot** — but the steps apply to any module.

If you're authoring tools, the two non-negotiable companion docs are:
- [`MCP_TOOL_DESCRIPTION_CONVENTION.md`](MCP_TOOL_DESCRIPTION_CONVENTION.md) — how every tool's description, schema, and annotations must read.
- [`MCP_RECIPES.md`](MCP_RECIPES.md) — multi-tool workflows the agent uses to orchestrate.

This guide is the "how to actually ship the thing" complement.

---

## TL;DR

1. **Pick a base shape**: `_template` (publishing flow with SQLite queue) OR `attio` (read/write external API + Result type + audit log).
2. **Copy** the chosen base into a new directory.
3. **Customize** identifiers, types, MCP tools, and external API client.
4. **Wire auth** through `holaboss-bridge` (Nango is the credential broker).
5. **Write tools** strictly per the convention — `registerTool`, structured description, `inputSchema` with `.describe()` on every field, `outputSchema`, explicit annotations.
6. **Add a recipe** to `MCP_RECIPES.md` for any non-obvious flow your tools enable.
7. **Test**: unit (Impl-level), integration (mock bridge), e2e (compose-up + curl), then sandbox e2e via the parent repo's runner.

Time budget per module: **0.5–1.5 days** if the API is well-documented and you reuse the right base.

---

## 0. Pre-flight checklist

Before opening an editor:

- [ ] Read the target service's API docs end-to-end (auth, rate limits, pagination, webhook support).
- [ ] Identify the 5–10 highest-value tools. Do NOT try to wrap the entire API. Each tool you add is permanent context the agent reads on every list-tools call.
- [ ] Sketch the user intents the module should serve. If you can't write 3 user prompts, you're guessing.
- [ ] Check whether Nango already has a connector for the service. If yes, auth is half-solved. If no, plan for token storage.
- [ ] Decide: does this module hold local state (drafts, queue) or is it a pure read/write proxy to the external API?

If you can answer all of those, you're ready to scaffold.

---

## 1. Pick a base shape

Two reference shapes exist — copy from whichever fits.

### Shape A — publishing module (twitter / linkedin / reddit / gmail)

Use when the module owns local state that goes through a status state machine, with an async send/publish step backed by a SQLite job queue.

Hallmarks:
- Local SQLite table (`posts`, `drafts`).
- State machine: `draft → queued → published / failed`.
- `enqueuePublish` / `enqueueSend` + a worker.
- MCP tools: `_create_*`, `_update_*`, `_publish_*` / `_send_*`, `_cancel_*`, `_delete_*`, `_get_*_status`, `_list_*`, `_get_queue_stats`.
- Single `mcp.ts` with inline `errCode` / `success` / `text` helpers.

### Shape B — external-API CRM module (attio / calcom)

Use when the module is mostly a thin, audited proxy over a third-party API. Local state is just an audit log of tool calls.

Hallmarks:
- `tools.ts` separated from `mcp.ts` (transport vs registration).
- Every tool returns `Result<T, <Module>Error>` (typed errors).
- `wrapTool` records every call (args, outcome, duration) into an `agent_actions` SQLite table — this powers the audit / activity UI.
- `asText(result)` helper threads `Result` through to MCP `content` + `structuredContent`.
- Connection bootstrap pattern: `<module>_get_connection_status` is the gate for everything else.

### Which shape fits the four upcoming modules?

| Module    | Shape | Reason |
|-----------|-------|--------|
| **Apollo**    | B (attio-style) | Pure proxy over Apollo's API; user-facing data lives in Apollo. Sequences add light state — store sequence_id locally, but don't queue. |
| **ZoomInfo**  | B (attio-style) | Pure read API. No local mutations beyond audit. |
| **Instantly** | A + B hybrid    | Lead lists + campaigns are external state; queued sends are external too — Shape B. But if you want LOCAL preview/approval before adding a lead to a campaign, layer in a tiny `pending_leads` table (Shape A's local-draft pattern). |
| **HubSpot**   | B (attio-style) | Massive surface; the smaller it stays, the better. Wrap only the 8–12 highest-value endpoints — never proxy "everything". |

**Default to Shape B** for the next four. Shape A's queue is only worth the complexity when sends MUST be batched / delayed locally (Twitter rate limits, scheduled posts).

---

## 2. Scaffold

```bash
cd hola-boss-apps/

# Shape A:
cp -r _template/ apollo/

# Shape B:
cp -r attio/ apollo/        # easiest — has tools.ts, audit, holaboss-bridge already wired
rm -rf apollo/node_modules apollo/.output apollo/data
cd apollo
```

Rename identifiers — every place that says `attio` / `Attio` / `attio-module` must become `apollo` / `Apollo` / `apollo-module`. Use a directed search:

```bash
grep -rln "attio\|Attio" --exclude-dir=node_modules --exclude-dir=.output | sort -u
```

Touch points (don't miss any):
- `package.json` — `name`, `description`
- `app.runtime.yaml` — `app_id`, `name`, `slug`, `lifecycle.start` env vars (`DB_PATH=./data/<module>.db`), `mcp.tools` list, `integration.destination`
- `docker-compose.yml` — service name, env names, volume name
- `src/lib/types.ts` — `MODULE_CONFIG`, error code type alias name (`AttioErrorCode` → `ApolloErrorCode`)
- `src/server/db.ts` — table names + migrations
- `src/server/<service>-client.ts` — rename file + class
- `src/server/tools.ts` — every tool name prefix (`attio_*` → `apollo_*`), every Impl function name (`createPersonImpl` → `createPersonImpl` is fine if it's still a person; rename if domain differs), every output shape constant
- `src/server/mcp.ts` — server name string
- `src/server/audit.ts` — table name, deep-link column name (`attio_deep_link` → `apollo_deep_link`)
- `src/routes/__root.tsx` — page title
- `src/routes/api/health.ts` — module name in response
- `src/styles.css` — brand `--primary` in OKLch (Apollo brand: deep blue; Instantly: orange-red; HubSpot: orange; ZoomInfo: blue-gray)
- `test/e2e.test.ts`, `test/integration/*` — describe blocks + import paths

After renaming, install:
```bash
rm -rf node_modules && pnpm install --maxsockets 1
```

Verify:
```bash
pnpm run typecheck   # must pass
pnpm run build       # must succeed
```

---

## 3. Auth: Nango + holaboss-bridge

Most modules talk to a third-party API on the user's behalf. The credential is held by **Nango** (the integration broker) and fetched via the `HOLABOSS_INTEGRATION_BROKER_URL` env var injected by the sandbox runtime.

### Pattern (copy from `attio/src/server/attio-client.ts`)

```ts
// <module>-client.ts
import { resolveHolabossTurnContext } from "./holaboss-bridge"

let bridgeClient: BridgeClient | null = null
export function setBridgeClient(c: BridgeClient) { bridgeClient = c }   // for tests

async function getCredential(): Promise<string> {
  if (!process.env.HOLABOSS_INTEGRATION_BROKER_URL) {
    throw new Error("not_connected")   // surfaced as code: 'not_connected'
  }
  const r = await fetch(`${process.env.HOLABOSS_INTEGRATION_BROKER_URL}/credentials/${MODULE_CONFIG.destination}`)
  if (!r.ok) throw new Error("not_connected")
  return (await r.json()).access_token
}

export async function apiGet<T>(path: string): Promise<Result<T, ApolloError>> {
  try {
    const token = await getCredential()
    const r = await fetch(`https://api.apollo.io/v1${path}`, { headers: { "X-Api-Key": token } })
    if (r.status === 401 || r.status === 403) return { ok: false, error: { code: "not_connected", message: "Apollo credential rejected" } }
    if (r.status === 429) return { ok: false, error: { code: "rate_limited", message: "Apollo rate limit", retry_after: Number(r.headers.get("retry-after") ?? 60) } }
    if (r.status >= 400 && r.status < 500) return { ok: false, error: { code: "validation_failed", message: await r.text() } }
    if (!r.ok) return { ok: false, error: { code: "upstream_error", message: `HTTP ${r.status}` } }
    return { ok: true, data: await r.json() as T }
  } catch (e) {
    return { ok: false, error: { code: e instanceof Error && e.message === "not_connected" ? "not_connected" : "upstream_error", message: e instanceof Error ? e.message : String(e) } }
  }
}
```

### Connection bootstrap tool

EVERY external-API module MUST expose `<module>_get_connection_status`. The agent calls it whenever any other tool returns `{ code: 'not_connected' }`, and on first use to confirm setup. Keep its description verbatim from attio's:

> When to use: ALWAYS call this first if any \<Module\> tool returns a not_connected error, or before suggesting \<Module\> features for the first time.

---

## 4. Design the tool surface

### Cap at ~10 tools per module

Every additional tool costs the agent ~150–300 tokens of context on every list-tools call. A 25-tool module is rarely worth the budget.

Keep the surface focused:

| Module    | Suggested 8–10 tools |
|-----------|---------------------|
| **Apollo**    | `_get_connection_status`, `_search_people` (by title/company/etc.), `_get_person`, `_get_email`, `_search_organizations`, `_get_organization`, `_list_sequences`, `_add_to_sequence`, `_remove_from_sequence`, `_list_emails_sent` |
| **ZoomInfo**  | `_get_connection_status`, `_search_contacts`, `_get_contact`, `_search_companies`, `_get_company`, `_get_intent`, `_get_org_chart` |
| **Instantly** | `_get_connection_status`, `_list_campaigns`, `_get_campaign`, `_create_campaign`, `_pause_campaign` (`destructiveHint: false`, `idempotentHint: true`), `_list_leads`, `_add_lead_to_campaign`, `_remove_lead_from_campaign`, `_get_campaign_stats`, `_send_test_email` |
| **HubSpot**   | `_get_connection_status`, `_search_contacts`, `_get_contact`, `_create_contact`, `_update_contact`, `_search_companies`, `_create_deal`, `_update_deal_stage`, `_add_note`, `_create_task` |

If a 9th tool is needed for a real user request, add it. If it's "for completeness", skip it.

### Apply the convention

Every tool MUST have:
- Module-prefixed snake_case name (`apollo_search_people`, not `searchPeople` or `apolloSearchPeople`).
- A `title` (≤ 6 words).
- A `description` with the 5-section structure (intro + When/When NOT/Prerequisites/Returns/Errors).
- `inputSchema` with `.describe()` on EVERY field — format, example, cross-ref.
- `outputSchema` if the tool returns a single object (not for raw arrays).
- `annotations` with all 4 hints set explicitly.
- Errors as `errCode(code, message, extra?)` (Shape A) or `Result<T, *Error>` → `asText` (Shape B).

Skim `attio/src/server/tools.ts` once before writing your own — it sets the bar for description quality.

### Cross-tool naming

Use the SAME verb across modules where the operation is the same. The agent transfers patterns between modules.

| Operation              | Verb        |
|------------------------|-------------|
| Find by query (fuzzy)  | `_search_*` (or `_find_*` if you mean an in-app catalog like Attio's) |
| Get one by id          | `_get_*`    |
| Create new             | `_create_*` |
| Update / patch         | `_update_*` |
| Upsert (create-or-update) | use one verb (`_add_to_*`) and document the upsert in the description |
| Delete (hard)          | `_delete_*` (`destructiveHint: true`) |
| Cancel (state change)  | `_cancel_*` |
| List many              | `_list_*`   |
| Pause / resume         | `_pause_*` / `_resume_*` |
| Status check           | `_get_*_status` |
| Connection check       | `_get_connection_status` |

Don't invent synonyms (`_fetch_*`, `_retrieve_*`, `_lookup_*`) — they make the agent's mental model fragmented.

---

## 5. Per-module notes

### Apollo

- **API**: REST, key in `X-Api-Key` header. Free tier rate-limits aggressively (100/hr). Surface `rate_limited` with `retry_after` so the agent backs off.
- **Schema gotcha**: Apollo's "person" object includes a nested `organization` sub-object. Don't make the agent re-fetch — return them together in `apollo_get_person`.
- **Sequences**: a "sequence" is Apollo's term for a multi-step email cadence. Adding a contact to one is the most common write; expose `apollo_add_to_sequence({ contact_id, sequence_id })` as the upsert (idempotent — re-adding does nothing).
- **Email finder**: `apollo_get_email({ first_name, last_name, domain })` is high-value but expensive (consumes credits). Document the credit cost in the description so the agent doesn't speculatively fan out.

### ZoomInfo

- **API**: OAuth2 client credentials flow, NOT user-OAuth. Token expires every hour — cache it in `<module>-client.ts`.
- **Search shape**: ZoomInfo returns paginated cursors, not offsets. Return the cursor in `outputSchema` as `next_cursor: string | null` so the agent can request the next page.
- **Compliance**: ZoomInfo data is licensed; don't write it back to anywhere except the user's CRM. Add a one-line note in the module's description (the MCP server-level `name` field) about licensing.
- **Intent**: `zoominfo_get_intent({ company_id })` returns hot keywords the company is researching. High-value for sales prospecting; expose it.

### Instantly

- **API**: REST, key in `Authorization` header. Webhook-driven for delivery events — for v1, poll `_get_campaign_stats`, don't try to wire webhooks into the sandbox.
- **Lead vs contact**: Instantly uses "lead" (a row in a campaign) distinct from a "contact" (the underlying person). Tool naming should follow that — `instantly_add_lead_to_campaign`, not `add_contact`.
- **Pausing campaigns**: `instantly_pause_campaign` is critical UX — users frequently want to stop a campaign mid-send. Make it idempotent (`pause` on an already-paused campaign is a no-op).
- **Test sends**: `instantly_send_test_email` should call the test endpoint, never the production send path. Mark `openWorldHint: true` (effect leaves system) and `destructiveHint: false`.

### HubSpot

- **API**: OAuth2 user-flow. Token refresh handled by Nango.
- **Surface discipline**: HubSpot has 100+ endpoints. Resist mapping them all. Stick to: contacts (search/get/create/update), companies (search/get), deals (create/move-stage), notes/tasks (create). Add tickets / marketing emails / forms only if a user explicitly asks for them.
- **Properties (custom fields)**: HubSpot has dynamic properties per portal. Mirror Attio's pattern — add `hubspot_describe_schema({ object: 'contacts' })` so the agent learns this portal's properties before `_create_contact`.
- **Pipelines**: HubSpot deals live in pipelines with stages. Expose `hubspot_list_pipelines` once (read-heavy) and `hubspot_update_deal_stage({ deal_id, pipeline_id, stage_id })`.
- **Rate limits**: 100 requests / 10 sec per token. Surface `rate_limited` with `retry_after`. The Nango broker re-uses tokens across all your tools, so be conservative.

---

## 6. Lifecycle config (`app.runtime.yaml`)

Copy from a similar shape, then change four things:

```yaml
app_id: "apollo-module"             # MUST end in -module
name: "Apollo"
slug: "apollo"

lifecycle:
  setup: "rm -rf node_modules && npm install --maxsockets 1 && npm run build"
  start: "DB_PATH=./data/apollo.db nohup node .output/server/index.mjs > /tmp/apollo.log 2>&1 & DB_PATH=./data/apollo.db nohup node .output/start-services.cjs > /tmp/apollo-services.log 2>&1 &"
  stop: "kill $(lsof -t -i :${PORT:-3000} 2>/dev/null) 2>/dev/null || true; kill $(lsof -t -i :${MCP_PORT:-3099} 2>/dev/null) 2>/dev/null || true"

healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 30

mcp:
  enabled: true
  transport: http-sse
  port: 3099
  path: /mcp/sse                    # MUST be /mcp/sse, not /mcp (overlay-FS / sandbox quirk)
  tools:
    - apollo_get_connection_status
    - apollo_search_people
    # ... list every tool you registered

integration:
  destination: "apollo"             # matches Nango connector slug
  credential_source: "platform"
  holaboss_user_id_required: true

env_contract:
  - "HOLABOSS_USER_ID"
  - "HOLABOSS_WORKSPACE_ID"
  - "HOLABOSS_INTEGRATION_BROKER_URL"
  - "HOLABOSS_APP_GRANT"
```

The sandbox runtime overrides `port` via `PORT` / `MCP_PORT` env vars — the value here is just a dev default.

---

## 7. Tests

Three layers, in increasing fidelity:

### Unit (`test/unit/*.test.ts`)
Test `Impl` functions in isolation by mocking the bridge client. Should run in < 5s without any network.

```ts
import { setBridgeClient } from "../../src/server/apollo-client"
import { MockBridge } from "../fixtures/mock-bridge"
import { searchPeopleImpl } from "../../src/server/tools"

it("returns ok with results on 200", async () => {
  const bridge = new MockBridge()
  bridge.whenGet("/people/search").respond(200, { people: [{ id: "p_1", name: "Alice" }] })
  setBridgeClient(bridge.asClient())
  const result = await searchPeopleImpl({ query: "alice" })
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.data.records).toHaveLength(1)
})
```

### Integration (`test/integration/*.test.ts`)
Full module loaded, MCP server up, but external API mocked. Verifies the registerTool wiring + asText threading.

### E2E (`test/e2e.test.ts`)
Spawns the docker-compose container, hits real `/mcp/sse`, exercises 1–2 tools end-to-end. Requires network OR a recorded fixture.

13–20 tests across the three layers is healthy. Below 10 means coverage gaps; above 30 usually means too much mock setup.

Run on every commit:
```bash
pnpm run typecheck && pnpm run lint && pnpm run test:e2e && pnpm run build
```

---

## 8. Add a recipe

Once tools are working, ask: "is there a 2+ tool flow a user typically wants that no single tool description conveys?" If yes, add a recipe to `MCP_RECIPES.md`.

Examples for the upcoming modules:

- **Apollo**: "Find decision-makers at Acme and add them to my outreach sequence" → `apollo_search_people` → `apollo_add_to_sequence`.
- **ZoomInfo + HubSpot**: "Pull the CTO of every Series B SaaS company in California into HubSpot" → `zoominfo_search_contacts` → loop → `hubspot_create_contact`.
- **Instantly**: "Pause all my campaigns, edit the subject line, restart" → `instantly_list_campaigns` → loop → `instantly_pause_campaign` → user edits → `instantly_resume_campaign`.

If you don't have a real user-intent for the recipe, skip it. Hypothetical recipes mislead more than help.

---

## 9. Pre-merge checklist

- [ ] All renames done (`grep -rln "<old_module_name>"` returns zero hits in source).
- [ ] `pnpm run typecheck` clean.
- [ ] `pnpm run test:e2e` passes.
- [ ] `pnpm run build` succeeds.
- [ ] `app.runtime.yaml` lists every tool you registered (the sandbox uses this list to advertise tools).
- [ ] Every tool description follows the convention. Pick three at random and verify they pass the "could the agent use this without examples?" test.
- [ ] Every `inputSchema` field has a `.describe()` with format + example.
- [ ] Every tool has explicit `annotations` (4 flags).
- [ ] Errors use `errCode(...)` (Shape A) or `Result<T, *Error>` (Shape B) — no plaintext error messages.
- [ ] CLAUDE.md updated to list the new module in the inventory.
- [ ] If the module enables a new multi-tool workflow: a recipe is in `MCP_RECIPES.md`.

---

## 10. After merge

- Add the module to the parent repo's `social_media` (or new) template if it should ship by default.
- Verify the module loads in a sandbox via `scripts/e2e-test.sh` (in the parent backend repo).
- Watch the audit table (`agent_actions`) for the first week — high `error_code: 'validation_failed'` rate usually means a description is misleading the agent.
