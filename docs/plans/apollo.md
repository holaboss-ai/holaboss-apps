# Apollo Module — Implementation Plan

**Status:** draft, awaiting review
**Base shape:** B (attio-style — `tools.ts` + `wrapTool` + `Result<T, ApolloError>` + `asText`)
**Estimated effort:** 1 day
**Companion docs:** [`MCP_TOOL_DESCRIPTION_CONVENTION.md`](../MCP_TOOL_DESCRIPTION_CONVENTION.md), [`APP_DEVELOPMENT_GUIDE.md`](../APP_DEVELOPMENT_GUIDE.md), [`MCP_RECIPES.md`](../MCP_RECIPES.md)

---

## 1. Goal

Wrap Apollo.io's REST API as a Holaboss module so an agent can:
- Find decision-makers at target companies (search by title, location, headcount, etc.).
- Enrich a name + domain into a verified email + phone.
- Push contacts into existing Apollo email sequences (cadences).
- Pull recent send activity for reporting.

**Non-goals (defer to v2):**
- Creating/editing sequences (templated cadence design is heavy UI work, not a chat use case).
- Lists / saved-search management.
- Webhook ingest.

## 2. User intents the module must serve

Real prompts the agent should be able to satisfy with these tools alone:

1. *"Find 20 VPs of Engineering at Series-B SaaS companies in California."*
2. *"What's the email for Jane Smith at Acme?"*
3. *"Add the people you just found to my 'Q2 Outbound — Eng Leaders' sequence."*
4. *"Did Bob from Acme reply to my last sequence email?"*
5. *"Pull a list of everyone we've contacted from Acme in the last 30 days."*
6. *"Show me Acme's tech stack and headcount."*

If a prompt outside this list comes up, the agent falls back to a general answer rather than us bloating the surface.

## 3. API research (verify against current docs as step 1)

- **Base URL:** `https://api.apollo.io/v1`
- **Auth:** API key in header `X-Api-Key: <key>`. Single-tenant per user. Stored in Nango under destination `apollo`.
- **Rate limits:** Free tier 100 req/hr, 600 req/day. Paid tiers higher. **Treat 429 as expected** — surface `{ code: 'rate_limited', retry_after: <secs> }` so the agent backs off.
- **Pagination:** Most list endpoints use `page` + `per_page` (max 100). Return `pagination: { page, per_page, total_entries, total_pages }` if useful.
- **Credit cost (CRITICAL):** `people/match` (email enrichment) consumes credits. Document this in the tool description so the agent doesn't speculatively fan out.

Endpoints we'll use (verify exact paths against [docs.apollo.io](https://docs.apollo.io/) on day 1):

| Tool | Method + path |
|------|---------------|
| connection check | `GET /auth/health` (or `GET /users/me` if no health endpoint) |
| search people | `POST /mixed_people/search` |
| get person | `GET /people/:id` |
| enrich person | `POST /people/match` (credit cost) |
| search organizations | `POST /mixed_companies/search` |
| get organization | `GET /organizations/:id` |
| list sequences | `GET /emailer_campaigns` |
| add to sequence | `POST /emailer_campaigns/:id/add_contact_ids` |
| remove from sequence | `POST /emailer_campaigns/:id/remove_contact_ids` |
| recent emails | `GET /emailer_messages` |

## 4. Tool surface (10 tools)

Tool names are FINAL — do not invent variants.

| # | Tool | Annotations | One-line purpose |
|---|------|-------------|------------------|
| 1 | `apollo_get_connection_status` | read+open | Verify Apollo is connected. Always call first on `not_connected`. |
| 2 | `apollo_search_people` | read+open | Find people matching a query (title, company, location, headcount). |
| 3 | `apollo_get_person` | read+open | Full details on one person id, including their organization. |
| 4 | `apollo_enrich_person` | read+open | Find email + phone for a person by name + domain. **Credit cost.** |
| 5 | `apollo_search_organizations` | read+open | Find companies matching a query (industry, headcount, tech stack, geography). |
| 6 | `apollo_get_organization` | read+open | Full details on one organization id. |
| 7 | `apollo_list_sequences` | read+open | List the user's email sequences (cadences) with id, name, status, step count. |
| 8 | `apollo_add_to_sequence` | write+open+idempotent | Push a contact into a sequence. Re-adding is a no-op (idempotent). |
| 9 | `apollo_remove_from_sequence` | write+open+idempotent | Remove a contact from a sequence. |
| 10 | `apollo_list_emails_sent` | read+open | Recent send activity — sent, opened, replied, bounced. Filter by contact_id or sequence_id. |

`read+open` = `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.
`write+open+idempotent` = `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true`.

## 5. Per-tool spec sketches

These are STARTER specs for the subagent — refine wording per the convention but keep the contract.

### `apollo_get_connection_status`

```ts
{
  title: "Check Apollo connection",
  description: `Check whether Apollo is connected for this workspace.

When to use: ALWAYS call this first if any Apollo tool returns { code: 'not_connected' }, or before suggesting Apollo features for the first time.
Returns: { connected: true, plan?, credits_remaining? } if linked, { connected: false } otherwise. If false, tell the user to connect Apollo from the Holaboss integrations page.`,
  inputSchema: {},
  outputSchema: {
    connected: z.boolean(),
    plan: z.string().optional(),
    credits_remaining: z.number().optional(),
    ...ToolSuccessMetaShape,
  },
  annotations: { title: "Check Apollo connection", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}
```

### `apollo_search_people`

```ts
inputSchema: {
  q_keywords: z.string().optional().describe("Free-text keywords across name/title/headline, e.g. 'staff engineer kubernetes'."),
  person_titles: z.array(z.string()).optional().describe("Job titles to match, e.g. ['VP Engineering', 'Director of Engineering']."),
  person_seniorities: z.array(z.enum(["c_suite","vp","director","manager","senior","entry","intern","owner","partner","head"])).optional(),
  organization_domains: z.array(z.string()).optional().describe("Restrict to people at these companies, e.g. ['acme.com', 'globex.com']."),
  person_locations: z.array(z.string()).optional().describe("Geographies, e.g. ['California, US', 'New York, US']."),
  organization_num_employees_ranges: z.array(z.string()).optional().describe("Headcount ranges, e.g. ['51,200', '201,500', '501,1000']."),
  page: z.number().int().positive().optional().describe("Page number, default 1."),
  per_page: z.number().int().positive().max(100).optional().describe("Default 25, max 100."),
}
outputSchema: {
  people: z.array(PersonSummarySchema),   // { id, name, title, organization: { id, name, domain }, location, ...}
  pagination: PaginationSchema.optional(),
  ...ToolSuccessMetaShape,
}
```

Description must mention: "Returns CONTACT INFO (email/phone) only if Apollo already had it cached for this user — otherwise call apollo_enrich_person."

### `apollo_enrich_person`

```ts
description: `Find a verified email and phone for a person by name + domain. CONSUMES CREDITS.

When to use: only when the user explicitly asks for an email/phone, or when apollo_search_people returned a person but no email_address. Don't speculatively call on every search hit.
Inputs: at minimum (first_name + last_name + organization_domain) OR (linkedin_url) OR (email if you want to confirm/enrich).
Returns: { person: { id, name, email, phone, organization, ... }, credits_consumed }.
Errors: { code: 'validation_failed' } if the trio doesn't match anyone. { code: 'rate_limited' } when the daily credit cap is hit.`
```

### `apollo_search_organizations`

```ts
inputSchema: {
  q_keywords: z.string().optional(),
  organization_domains: z.array(z.string()).optional().describe("Match these exact domains, e.g. ['acme.com']."),
  industries: z.array(z.string()).optional().describe("e.g. ['saas', 'fintech']."),
  num_employees_ranges: z.array(z.string()).optional(),
  technologies: z.array(z.string()).optional().describe("Tech stack, e.g. ['salesforce', 'snowflake']."),
  page: z.number().int().positive().optional(),
  per_page: z.number().int().positive().max(100).optional(),
}
```

### `apollo_list_sequences`

Return `{ sequences: [{ id, name, status, num_steps, created_at }] }`. Status ∈ `'active' | 'paused' | 'archived'`.

### `apollo_add_to_sequence`

```ts
description: `Add a contact to an Apollo email sequence (cadence). Idempotent — re-adding the same contact is a no-op.

When to use: the user has approved a sequence and wants this person enrolled.
Prerequisites: sequence_id from apollo_list_sequences; contact_id from apollo_search_people / apollo_enrich_person.
Side effects: the contact starts receiving sequence emails on the next scheduled send.
Returns: { contact_id, sequence_id, added: true } or { contact_id, sequence_id, added: false, reason: 'already_in_sequence' }.`
inputSchema: {
  sequence_id: z.string(),
  contact_ids: z.array(z.string()).min(1).max(100).describe("Apollo contact ids. Pass multiple to bulk-add."),
}
```

### `apollo_remove_from_sequence`

Mirror of add. Idempotent: removing someone not in the sequence is a no-op.

### `apollo_list_emails_sent`

```ts
inputSchema: {
  contact_id: z.string().optional().describe("Filter by recipient. Either this OR sequence_id is required."),
  sequence_id: z.string().optional(),
  status: z.enum(["sent","opened","replied","bounced","clicked"]).optional(),
  since: z.string().optional().describe("ISO 8601 date, e.g. '2026-04-01T00:00:00Z'."),
  limit: z.number().int().positive().max(100).optional(),
}
outputSchema: {
  emails: z.array(EmailEventSchema),  // { id, contact_id, sequence_id, subject, sent_at, opened_at?, replied_at?, ... }
  ...ToolSuccessMetaShape,
}
```

## 6. Auth bootstrap

Copy `attio/src/server/attio-client.ts` → `apollo/src/server/apollo-client.ts`. Changes:

- `MODULE_CONFIG.destination = "apollo"` (so Nango knows which connector to fetch).
- Auth header: `X-Api-Key: <token>` (NOT `Authorization: Bearer ...`).
- Map status → error code:

```ts
if (r.status === 401 || r.status === 403) return { ok: false, error: { code: "not_connected", message: "Apollo credential rejected" } }
if (r.status === 422) return { ok: false, error: { code: "validation_failed", message: <body.error or body.message> } }
if (r.status === 429) {
  const retry = Number(r.headers.get("retry-after") ?? 60)
  return { ok: false, error: { code: "rate_limited", message: "Apollo rate limit", retry_after: retry } }
}
if (r.status >= 500) return { ok: false, error: { code: "upstream_error", message: `HTTP ${r.status}` } }
```

## 7. Local state

**SQLite tables:**
- `agent_actions` (audit log) — copied from attio, no changes.
- No domain tables. Apollo holds the truth; we don't cache.

If we later need a `pending_enrichments` table to dedupe expensive `enrich_person` calls within a session, add it as a follow-up — not v1.

## 8. Test plan

Three layers, mirror attio's structure:

**Unit (`test/unit/`):**
- `apollo-client.test.ts` — status-to-error-code mapping (200, 401, 422, 429, 500).
- `tools-search-people.test.ts` — input shape → API call URL + body.
- `tools-enrich-person.test.ts` — credit-cost description present, validation_failed on missing trio.
- `tools-add-to-sequence.test.ts` — idempotent return shape.

**Integration (`test/integration/`):**
- `mcp-roundtrip.test.ts` — register tools, call `apollo_get_connection_status` via MCP transport, assert `structuredContent` matches `outputSchema`.

**E2E (`test/e2e.test.ts`):**
- Boots docker-compose, hits real `/mcp/sse`, exercises `_get_connection_status` (with mock bridge fixture) + one `_search_people` round-trip.

Target: 14–18 tests total.

## 9. Implementation sequence

**Phase 1 — Scaffold (~1 hr)**
- [ ] `cp -r attio/ apollo/`
- [ ] Rename every `attio` / `Attio` / `attio-module` → `apollo` / `Apollo` / `apollo-module`. Verify with `grep -rln "attio" --exclude-dir=node_modules` returning zero hits.
- [ ] `pnpm install --maxsockets 1 && pnpm run typecheck` — must pass before continuing.
- [ ] Update `app.runtime.yaml` `mcp.tools` list with all 10 tool names.

**Phase 2 — Client + auth (~1 hr)**
- [ ] Rewrite `apollo-client.ts` with `X-Api-Key` header + status-to-error-code mapping above.
- [ ] Implement `getConnectionStatusImpl` (probably `GET /users/me`).
- [ ] Wire `apollo_get_connection_status` end-to-end.
- [ ] Add unit test for the status mapping.

**Phase 3 — Read tools (~2 hr)**
- [ ] `apollo_search_people` (Impl + register + unit + integration).
- [ ] `apollo_get_person`.
- [ ] `apollo_search_organizations`.
- [ ] `apollo_get_organization`.
- [ ] `apollo_list_sequences`.
- [ ] `apollo_list_emails_sent`.

**Phase 4 — Write tools (~1.5 hr)**
- [ ] `apollo_enrich_person` — descriptions MUST mention credit cost.
- [ ] `apollo_add_to_sequence` — verify idempotency in test.
- [ ] `apollo_remove_from_sequence`.

**Phase 5 — Polish (~1 hr)**
- [ ] Run `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:e2e`, `pnpm run build`. All must pass.
- [ ] Add 2 recipes to `MCP_RECIPES.md`:
  - "Find decision-makers at a company and add to sequence"
  - "Enrich a name + domain → push to sequence"
- [ ] Add Apollo row to `CLAUDE.md` repository layout + data model table.
- [ ] Pre-merge checklist (in `APP_DEVELOPMENT_GUIDE.md` §9).

## 10. Open questions for human review

- [ ] **Confirm endpoint paths** against the current Apollo API docs before Phase 2. The list in §3 is best-effort from prior knowledge.
- [ ] **Nango connector slug** — does it already exist? If not, we'll need to add it before this module can run end-to-end. Confirm with whoever owns Nango setup.
- [ ] **Should `apollo_create_contact` be in v1?** I argue defer — Apollo prefers searching the existing 275M-contact DB over creating fresh contacts. If sales team disagrees, add as tool #11.
- [ ] **Brand color for `styles.css`** — Apollo's brand is a muted teal/blue. Pick: `oklch(0.55 0.13 220)` or fetch from Apollo's brand kit.
- [ ] **`apollo_search_people` returns email when?** Confirm whether the search endpoint returns email addresses for free-tier users or requires `enrich_person` for any contact info. This dictates whether the agent always needs a 2-step flow.

Once these are answered, the subagent has everything it needs.
