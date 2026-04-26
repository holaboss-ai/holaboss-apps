# ZoomInfo Module — Implementation Plan

**Status:** draft, awaiting review
**Base shape:** B (attio-style)
**Estimated effort:** 1 day
**Companion docs:** [`MCP_TOOL_DESCRIPTION_CONVENTION.md`](../MCP_TOOL_DESCRIPTION_CONVENTION.md), [`APP_DEVELOPMENT_GUIDE.md`](../APP_DEVELOPMENT_GUIDE.md)

---

## 1. Goal

Wrap ZoomInfo's API as a Holaboss read-only intelligence module so an agent can:
- Look up contact details (email + phone + title) for known people.
- Search for contacts matching a target persona (title, function, geography).
- Enrich a company with firmographics, tech stack, and intent signals.
- Inspect an organization's leadership (org chart top-N).

ZoomInfo is the **gold standard B2B dataset**. The module is read-only — never write back to ZoomInfo.

**Non-goals (defer):**
- Bulk enrichment (CSV upload flows). Out of chat scope.
- ZoomInfo Engage / Chorus / SalesOS write APIs.
- Webhook ingest of intent signals.
- Caching ZoomInfo data in our SQLite — licensing forbids it (see §10).

## 2. User intents the module must serve

1. *"Find me 50 CMOs at fintech companies in the EU."*
2. *"Get the email and phone for Alice Johnson, CTO at Acme."*
3. *"What's Acme's tech stack and how big is their engineering team?"*
4. *"What is Globex actively researching right now?"* (intent data)
5. *"Show me Acme's executive team."*
6. *"Has Acme had any recent funding rounds or leadership changes?"*

## 3. API research (verify against current docs as step 1)

- **Base URL:** `https://api.zoominfo.com`
- **Auth:** OAuth2 client credentials flow. POST `https://api.zoominfo.com/authenticate` with `{ username, password }` (or `{ clientId, privateKey, username }` for PKI). Response includes `jwt`. Token TTL ~1 hour. **Cache the token in-process** with a small wrapper that re-auths on 401.
- **Auth header on data calls:** `Authorization: Bearer <jwt>`.
- **Pagination:** Cursor-based via `outputCursor` field in responses. Pass back as `cursor` on next call. Return `next_cursor: string | null` in our outputSchema.
- **Rate limits:** 25 RPS per user, daily quota varies by contract. Surface 429 as `rate_limited`.
- **Compliance (CRITICAL):** ZoomInfo's data is licensed. Our tool descriptions MUST mention "data is licensed by ZoomInfo — only use to populate the user's own CRM, do not share externally."

Endpoints (verify against [api-docs.zoominfo.com](https://api-docs.zoominfo.com/) on day 1):

| Tool | Method + path |
|------|---------------|
| connection check | `GET /lookup/inputfields/contact/search` (lightweight) or `POST /authenticate` |
| search contacts | `POST /search/contact` |
| enrich contact (one) | `POST /enrich/contact` (cost-bearing) |
| search companies | `POST /search/company` |
| enrich company (one) | `POST /enrich/company` |
| intent | `POST /intent` |
| org chart | `POST /search/contact` filtered by `companyId` + `managementLevel: ['c_level','vp_level']` |

## 4. Tool surface (7 tools)

ZoomInfo's value is concentrated; resist adding more.

| # | Tool | Annotations | One-line purpose |
|---|------|-------------|------------------|
| 1 | `zoominfo_get_connection_status` | read+open | Verify ZoomInfo is connected. |
| 2 | `zoominfo_search_contacts` | read+open | Find contacts matching persona criteria (title, function, geography). |
| 3 | `zoominfo_enrich_contact` | read+open | Get full contact details (email, phone, ...) for a single person by id or (name + company). **Credit cost.** |
| 4 | `zoominfo_search_companies` | read+open | Find companies matching firmographic filters. |
| 5 | `zoominfo_enrich_company` | read+open | Get full company details (firmographics, tech stack, employee count, recent news) for a single company by id or domain. |
| 6 | `zoominfo_get_intent` | read+open | Buyer intent signals — what topics is this company actively researching. |
| 7 | `zoominfo_get_org_chart` | read+open | C-suite + VP-level executives at a company, returned as a flat list (we don't model hierarchy in v1). |

All 7 are `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.

## 5. Per-tool spec sketches

### `zoominfo_get_connection_status`

```ts
description: `Check whether ZoomInfo is connected for this workspace.

When to use: ALWAYS call this first if any zoominfo_* tool returns { code: 'not_connected' }, or before suggesting ZoomInfo features for the first time.
Returns: { connected: true, daily_quota_remaining? } if linked, { connected: false } otherwise.

Note: ZoomInfo data is licensed. Use to populate the user's own CRM only — do not export or share externally.`
outputSchema: {
  connected: z.boolean(),
  daily_quota_remaining: z.number().optional(),
  ...ToolSuccessMetaShape,
}
```

### `zoominfo_search_contacts`

```ts
inputSchema: {
  job_titles: z.array(z.string()).optional().describe("e.g. ['Chief Marketing Officer', 'VP Marketing']."),
  management_levels: z.array(z.enum(["c_level","vp_level","director_level","manager_level","non_manager"])).optional(),
  job_functions: z.array(z.string()).optional().describe("e.g. ['marketing','sales','engineering']."),
  company_ids: z.array(z.string()).optional().describe("Restrict to specific ZoomInfo company ids."),
  company_domains: z.array(z.string()).optional().describe("Restrict to companies by domain, e.g. ['acme.com']."),
  locations: z.array(z.string()).optional().describe("Geographies, e.g. ['US-CA', 'GB', 'DE']. Use country or country-state codes."),
  cursor: z.string().nullable().optional().describe("Cursor from a previous page's next_cursor. Omit on first call."),
  page_size: z.number().int().positive().max(100).optional().describe("Default 25, max 100."),
}
outputSchema: {
  contacts: z.array(ContactSummarySchema),  // { id, first_name, last_name, job_title, company: { id, name, domain }, location, ... }
  next_cursor: z.string().nullable(),
  ...ToolSuccessMetaShape,
}
description: `Search ZoomInfo's B2B contact database by persona criteria.

When to use: prospecting — "find me 50 CMOs at fintechs in the EU".
When NOT to use: to look up a known person — use zoominfo_enrich_contact instead.
Returns: contacts WITHOUT email/phone (those require zoominfo_enrich_contact). Use next_cursor for pagination.

Note: ZoomInfo data is licensed; populate only the user's own CRM.`
```

Search returns metadata only; enrichment returns the contact details. This is ZoomInfo's standard tier model — be explicit so the agent doesn't expect emails from search.

### `zoominfo_enrich_contact`

```ts
description: `Get full contact details (email, direct phone, mobile, business address) for ONE person.

When to use: the user wants to actually contact someone, not just see they exist.
Inputs: either contact_id (from search) OR (first_name + last_name + company_id-or-domain).
CONSUMES CREDITS — don't call speculatively for every search result.
Returns: { contact: { id, name, email, phone, mobile, title, company, ... } }.
Errors: { code: 'not_found' } if no match. { code: 'rate_limited' } when daily credit cap hit.`
inputSchema: {
  contact_id: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company_id: z.string().optional(),
  company_domain: z.string().optional(),
}
```

Implementation: validate that `contact_id` OR `(first_name + last_name + (company_id or company_domain))` is supplied; otherwise return `validation_failed`.

### `zoominfo_search_companies`

```ts
inputSchema: {
  industries: z.array(z.string()).optional().describe("e.g. ['Computer Software','Fintech']."),
  employee_count_ranges: z.array(z.string()).optional().describe("e.g. ['11-50','51-200','201-500','501-1000','1001-5000','5001+']."),
  revenue_ranges: z.array(z.string()).optional().describe("e.g. ['$1M-$10M','$10M-$50M']."),
  locations: z.array(z.string()).optional(),
  technologies: z.array(z.string()).optional().describe("Tech stack, e.g. ['Snowflake','React','AWS']."),
  cursor: z.string().nullable().optional(),
  page_size: z.number().int().positive().max(100).optional(),
}
```

### `zoominfo_enrich_company`

Returns full firmographics, tech stack, recent news/funding, employee counts by department.

### `zoominfo_get_intent`

```ts
description: `Get buyer intent signals — what topics this company is actively researching across the web.

When to use: qualify timing — "is this account in-market right now?".
Returns: { intent_topics: [{ topic, score, trending_since }], company_id }. Score is 0–100; topics with score > 70 indicate strong buying intent.`
inputSchema: {
  company_id: z.string().optional(),
  company_domain: z.string().optional(),
  topics: z.array(z.string()).optional().describe("Restrict to specific topics, e.g. ['CRM','Marketing Automation']."),
}
```

### `zoominfo_get_org_chart`

```ts
description: `List C-suite + VP-level executives at a company. Flat list (not hierarchical).

When to use: identify decision-makers and their reports for a target account.
Returns: { executives: [{ id, name, title, management_level, function }] }. Use zoominfo_enrich_contact to get email/phone for any one of them.`
inputSchema: {
  company_id: z.string().optional(),
  company_domain: z.string().optional(),
  levels: z.array(z.enum(["c_level","vp_level","director_level"])).optional().describe("Default ['c_level','vp_level']."),
}
```

## 6. Auth bootstrap

Use `createIntegrationClient("zoominfo").proxy(...)` from the `@holaboss/bridge` SDK shim. The Holaboss broker handles ZoomInfo's `/authenticate` → JWT exchange and `Authorization: Bearer ...` injection internally — modules NEVER mint or cache JWTs themselves.

```ts
import { createIntegrationClient } from "./holaboss-bridge"
const client = createIntegrationClient("zoominfo")
const r = await client.proxy<...>({
  method: "POST",
  endpoint: "https://api.zoominfo.com/search/contact",
  body: { rpp: 25, jobTitle: "CMO" },
})
// r === { data, status, headers }
```

Status mapping (same shape as Apollo):
- 401/403 → `not_connected` (broker will refresh credentials on its next attempt)
- 422/400 → `validation_failed`
- 429 → `rate_limited` with `retry_after`
- 5xx → `upstream_error`

## 7. Local state

- `agent_actions` (audit log) — copied from attio.
- **No domain tables.** Caching ZoomInfo data violates license.
- JWT cache is **in-process only** (`let cachedJwt: ...`), never persisted to disk.

## 8. Test plan

**Unit:**
- `zoominfo-client.test.ts` — JWT cache hit/miss, 401 → re-auth, status mapping.
- `tools-search-contacts.test.ts` — input → request body shape.
- `tools-enrich-contact.test.ts` — validation_failed when neither id nor (name + company) supplied.
- `tools-get-intent.test.ts` — score thresholds documented in description match returned shape.

**Integration:**
- `mcp-roundtrip.test.ts` — registerTool wiring + structuredContent matching outputSchema.

**E2E:**
- Boot docker-compose, hit `/mcp/sse`, exercise `_get_connection_status` + `_search_companies` with mock bridge.

Target: 12–15 tests.

## 9. Implementation sequence

**Phase 1 — Scaffold (~1 hr)**
- [ ] `cp -r attio/ zoominfo/`, rename, install, typecheck.
- [ ] Update `app.runtime.yaml`.

**Phase 2 — Auth + connection (~1.5 hr)**
- [ ] `zoominfo-client.ts` with JWT cache.
- [ ] `zoominfo_get_connection_status` working end-to-end.
- [ ] Unit test for JWT cache hit/miss/refresh-on-401.

**Phase 3 — Read tools (~2.5 hr)**
- [ ] `zoominfo_search_contacts` (incl. pagination cursor handling).
- [ ] `zoominfo_search_companies`.
- [ ] `zoominfo_enrich_contact`.
- [ ] `zoominfo_enrich_company`.
- [ ] `zoominfo_get_intent`.
- [ ] `zoominfo_get_org_chart`.

**Phase 4 — Polish (~1 hr)**
- [ ] All gates green: typecheck + lint + test + build.
- [ ] Add 1 recipe: "Pull C-suite at target accounts → enrich emails → push to HubSpot/Attio."
- [ ] CLAUDE.md row added.

## 10. Open questions for human review

- [ ] **Broker connector** — confirm the Holaboss broker has a `zoominfo` connector that handles the `/authenticate` JWT exchange + `Authorization: Bearer ...` injection. If not, that's a Holaboss-side ticket; the module's code shape stays the same.
- [ ] **Licensing language** — the "data is licensed; only populate user's own CRM" line in tool descriptions: get sign-off from legal that this phrasing matches our Master Agreement with ZoomInfo.
- [ ] **Quota visibility** — does ZoomInfo's API expose `daily_quota_remaining` per request? If yes, surface in `_get_connection_status`. If no, drop from outputSchema.
- [ ] **Should v1 include `zoominfo_get_funding_history`?** ZoomInfo has rich firmographic news — could be a separate tool. Defer to v2 unless sales explicitly asks.
- [ ] **Brand color for `styles.css`** — ZoomInfo's brand is a navy blue. Suggest `oklch(0.32 0.10 250)`.
