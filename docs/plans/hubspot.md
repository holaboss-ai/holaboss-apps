# HubSpot Module — Implementation Plan

**Status:** draft, awaiting review
**Base shape:** B (attio-style)
**Estimated effort:** 1.5 days (largest of the four — bigger surface, dynamic properties)
**Companion docs:** [`MCP_TOOL_DESCRIPTION_CONVENTION.md`](../MCP_TOOL_DESCRIPTION_CONVENTION.md), [`APP_DEVELOPMENT_GUIDE.md`](../APP_DEVELOPMENT_GUIDE.md)

---

## 1. Goal

Wrap HubSpot's CRM as a Holaboss module so an agent can:
- Find / create / update contacts.
- Find / inspect companies.
- Move deals through pipeline stages.
- Log notes and tasks against contacts / companies / deals.
- Discover the portal's custom properties (mirroring `attio_describe_schema`).

**Critical discipline:** HubSpot has 100+ endpoints. We expose ~12. Every additional tool is permanent token cost. Resist scope creep.

**Non-goals (defer):**
- Marketing emails, forms, landing pages, workflows (different product surfaces — different scope).
- Tickets / Service Hub (separate use case).
- File attachments to engagements.
- Quote / line-item management.
- Webhook ingest.
- Bulk imports (use HubSpot's UI for that).

## 2. User intents the module must serve

1. *"Look up Bob from Acme in HubSpot — what's his deal stage?"*
2. *"Add Alice as a new contact, link her to Acme, put her in the 'Active Discovery' stage."*
3. *"What pipelines do I have, and what stages are in 'New Business'?"*
4. *"Move Acme's deal from 'Demo' to 'Proposal'."*
5. *"Log a meeting summary against Bob — we discussed pricing concerns."*
6. *"Create a task to follow up with Carol next Tuesday."*
7. *"What custom properties does my portal use on contacts?"* (for `_describe_schema`)
8. *"Find every contact whose lifecycle_stage is 'opportunity' and was last contacted over 30 days ago."*

## 3. API research (verify against current docs as step 1)

- **Base URL:** `https://api.hubapi.com`
- **Auth:** OAuth2 user flow via Nango. Token in `Authorization: Bearer <access_token>`. Refresh handled by Nango.
- **Rate limits:** 100 req / 10 sec per access token (Standard tier). Surface 429 as `rate_limited`. Burst limits also exist.
- **Pagination:** Cursor via `paging.next.after`. Pass back as `after` on next call. Return `next_cursor: string | null`.
- **Properties (CRITICAL):** HubSpot CRM objects have dynamic properties per portal — every customer has different custom fields. Tools that create/update objects MUST be paired with a `_describe_schema` lookup, just like Attio.
- **Search vs list:** Use `POST /crm/v3/objects/{type}/search` for filtered queries (it has rich filter operators). Plain `GET /crm/v3/objects/{type}` lists ALL with no filtering — usually not what the agent wants.

Endpoints (verify against [developers.hubspot.com](https://developers.hubspot.com/docs/api/overview) on day 1):

| Tool | Method + path |
|------|---------------|
| connection check | `GET /crm/v3/owners/?limit=1` (lightweight, requires basic CRM scope) |
| describe schema | `GET /crm/v3/properties/{objectType}` (objectType ∈ contacts/companies/deals) |
| search contacts | `POST /crm/v3/objects/contacts/search` |
| get contact | `GET /crm/v3/objects/contacts/:id` |
| create contact | `POST /crm/v3/objects/contacts` |
| update contact | `PATCH /crm/v3/objects/contacts/:id` |
| search companies | `POST /crm/v3/objects/companies/search` |
| list pipelines | `GET /crm/v3/pipelines/deals` |
| create deal | `POST /crm/v3/objects/deals` |
| update deal stage | `PATCH /crm/v3/objects/deals/:id` (set `dealstage` property) |
| add note (engagement) | `POST /crm/v3/objects/notes` + association payload |
| create task (engagement) | `POST /crm/v3/objects/tasks` + association payload |

## 4. Tool surface (12 tools)

Largest of the four, but capped at 12.

| # | Tool | Annotations | One-line purpose |
|---|------|-------------|------------------|
| 1 | `hubspot_get_connection_status` | read+open | Verify HubSpot is connected; report portal id and base scopes. |
| 2 | `hubspot_describe_schema` | read+open | List properties (incl. custom) for contacts / companies / deals. **Always call before _create/_update.** |
| 3 | `hubspot_search_contacts` | read+open | Filter contacts by property values (lifecycle_stage, last_contacted, owner, ...). |
| 4 | `hubspot_get_contact` | read+open | Full contact record with all properties. |
| 5 | `hubspot_create_contact` | write+open | Create a contact. Pass `properties` as `{slug: value}`. |
| 6 | `hubspot_update_contact` | write+open+idempotent | Patch named properties on an existing contact. |
| 7 | `hubspot_search_companies` | read+open | Filter companies by domain / industry / property. |
| 8 | `hubspot_list_pipelines` | read+open | List deal pipelines + their stages. **Always call before _create_deal / _update_deal_stage.** |
| 9 | `hubspot_create_deal` | write+open | Create a deal. Requires pipeline_id + stage_id from `_list_pipelines`. |
| 10 | `hubspot_update_deal_stage` | write+open+idempotent | Move a deal to a different stage. |
| 11 | `hubspot_add_note` | write+open | Attach a plaintext note to contact / company / deal. |
| 12 | `hubspot_create_task` | write+open | Create a task with deadline + assignee, optionally linked to records. |

`read+open` = readOnly+idempotent+openWorld. `write+open` = !readOnly+!destructive+!idempotent+openWorld (unless explicitly idempotent). `write+open+idempotent` = the same with `idempotentHint: true`.

No `_delete_*` tools in v1 — deletion in HubSpot is rare and high-risk; force users to do it via UI.

## 5. Per-tool spec sketches

### `hubspot_get_connection_status`

```ts
outputSchema: {
  connected: z.boolean(),
  portal_id: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  ...ToolSuccessMetaShape,
}
description: `Check whether HubSpot is connected for this workspace.

When to use: ALWAYS call this first if any hubspot_* tool returns { code: 'not_connected' }, or before suggesting HubSpot features for the first time.
Returns: { connected: true, portal_id, scopes } if linked, { connected: false } otherwise. Scopes lists the OAuth scopes granted — useful when a tool fails because a scope is missing.`
```

### `hubspot_describe_schema`

```ts
description: `Describe properties (incl. custom) for a HubSpot CRM object type.

When to use: ALWAYS call before hubspot_create_contact / hubspot_update_contact / hubspot_create_deal — every portal has different custom fields and required-property rules.
Returns: { object_type, properties: [{ name, label, type, fieldType, options?, required }] }. 'name' is the slug to pass into create/update; 'options' lists allowed values for enums.`
inputSchema: {
  object_type: z.enum(["contacts","companies","deals","tickets"]).describe("Which CRM object's schema to fetch."),
}
outputSchema: {
  object_type: z.string(),
  properties: z.array(z.object({
    name: z.string(),
    label: z.string(),
    type: z.string(),               // 'string','number','enumeration','date','datetime','bool'
    fieldType: z.string(),          // 'text','number','select','date','calculation','phonenumber',...
    options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    is_required: z.boolean().optional(),
    is_calculated: z.boolean().optional(),
  })),
  ...ToolSuccessMetaShape,
}
```

### `hubspot_search_contacts`

```ts
inputSchema: {
  query: z.string().optional().describe("Free-text — searches default text props (firstname, lastname, email, etc.)."),
  filters: z.array(z.object({
    property: z.string().describe("Property slug, e.g. 'lifecyclestage', 'last_contacted_date'."),
    operator: z.enum(["EQ","NEQ","LT","LTE","GT","GTE","BETWEEN","IN","NOT_IN","HAS_PROPERTY","NOT_HAS_PROPERTY","CONTAINS_TOKEN","NOT_CONTAINS_TOKEN"]),
    value: z.unknown().optional().describe("Right-hand-side value. Type depends on operator + property."),
    values: z.array(z.unknown()).optional().describe("For IN / NOT_IN / BETWEEN."),
  })).optional().describe("AND-combined filters. For OR, call multiple times."),
  properties: z.array(z.string()).optional().describe("Properties to return per contact, e.g. ['email','firstname','lifecyclestage']. Default: a small set."),
  sorts: z.array(z.object({
    property: z.string(),
    direction: z.enum(["ASCENDING","DESCENDING"]),
  })).optional(),
  limit: z.number().int().positive().max(100).optional(),
  after: z.string().optional().describe("Cursor from previous page's next_cursor."),
}
outputSchema: {
  contacts: z.array(z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) })),
  next_cursor: z.string().nullable(),
  ...ToolSuccessMetaShape,
}
description: `Search HubSpot contacts using property filters and free-text query.

When to use: any "find contacts where X" — filter by lifecycle_stage, owner_id, last_contacted_date, custom properties.
When NOT to use: simple "get by id" — use hubspot_get_contact.
Prerequisites: call hubspot_describe_schema first to learn property slugs (especially custom fields).
Returns: array of { id, properties: {...} } where properties keys are the slugs you requested. Use next_cursor to paginate.`
```

### `hubspot_create_contact`

```ts
description: `Create a new contact in HubSpot.

When to use: after hubspot_search_contacts confirms the contact doesn't already exist (HubSpot dedupes on email by default, so passing an email that exists creates an error).
Prerequisites: call hubspot_describe_schema to learn required properties for this portal.
Returns: { contact_id, hubspot_deep_link }.
Errors: { code: 'validation_failed' } if a required property is missing or a value violates an enum/format constraint. The 'message' lists the offending property.`
inputSchema: {
  properties: z.record(z.string(), z.unknown()).describe("Map of property_slug → value, e.g. { email: 'a@b.com', firstname: 'Alice', lastname: 'Smith', lifecyclestage: 'lead' }. Slugs from hubspot_describe_schema."),
  associations: z.array(z.object({
    to_object_type: z.enum(["companies","deals"]),
    to_object_id: z.string(),
    association_type: z.string().optional().describe("HubSpot association type id; default 'primary'."),
  })).optional().describe("Optionally link the new contact to existing companies or deals at create time."),
}
```

### `hubspot_update_contact`

Idempotent (re-applying the same properties is a no-op). Same property-map shape as create, plus `contact_id`.

### `hubspot_search_companies`

Mirror of contacts search.

### `hubspot_list_pipelines`

```ts
description: `List all deal pipelines in this portal, with their stages.

When to use: ALWAYS call before hubspot_create_deal or hubspot_update_deal_stage — pipeline_id and stage_id are portal-specific.
Returns: array of { pipeline_id, label, stages: [{ stage_id, label, display_order, probability }] }.`
inputSchema: {}
outputSchema: {
  pipelines: z.array(z.object({
    pipeline_id: z.string(),
    label: z.string(),
    stages: z.array(z.object({
      stage_id: z.string(),
      label: z.string(),
      display_order: z.number(),
      probability: z.number().nullable(),
    })),
  })),
  ...ToolSuccessMetaShape,
}
```

### `hubspot_create_deal`

```ts
inputSchema: {
  properties: z.record(z.string(), z.unknown()).describe("e.g. { dealname: 'Acme Q2', amount: 50000, dealstage: '<stage_id>', pipeline: '<pipeline_id>' }. dealstage and pipeline are required."),
  associations: z.array(z.object({
    to_object_type: z.enum(["contacts","companies"]),
    to_object_id: z.string(),
  })).optional().describe("Link the deal to contacts and the buyer company."),
}
description: `Create a new HubSpot deal.

Prerequisites: hubspot_list_pipelines for pipeline_id + stage_id; hubspot_describe_schema (object_type: 'deals') for any custom required properties.
Returns: { deal_id, hubspot_deep_link }.`
```

### `hubspot_update_deal_stage`

```ts
description: `Move a deal to a different stage in its pipeline.

When to use: progressing a deal — "move Acme to 'Proposal'".
Prerequisites: deal_id from hubspot_search_companies (associations) or another lookup. stage_id from hubspot_list_pipelines.
Returns: { deal_id, dealstage, hubspot_deep_link }.
Errors: { code: 'validation_failed' } if stage_id doesn't belong to this deal's pipeline.`
inputSchema: {
  deal_id: z.string(),
  stage_id: z.string().describe("Target stage_id from hubspot_list_pipelines."),
}
```

### `hubspot_add_note`

```ts
description: `Attach a plaintext note (a HubSpot 'engagement') to a contact, company, or deal. The note appears in the record's activity timeline.

When to use: log meeting summaries, follow-up details, free-form context.
Returns: { note_id, hubspot_deep_link }.`
inputSchema: {
  parent_object: z.enum(["contacts","companies","deals"]),
  parent_record_id: z.string(),
  content: z.string().describe("Note body. Plaintext (HubSpot will display it in its activity timeline)."),
  timestamp: z.string().optional().describe("ISO 8601 — when the activity happened. Default: now."),
}
```

### `hubspot_create_task`

```ts
description: `Create a HubSpot task (a to-do engagement) optionally linked to records.

When to use: capture an action item — "follow up with Alice next Tuesday".
Returns: { task_id, hubspot_deep_link }.`
inputSchema: {
  subject: z.string().describe("Task title, e.g. 'Send Q2 proposal to Alice'."),
  body: z.string().optional().describe("Task description / notes."),
  due_date: z.string().optional().describe("ISO 8601 with timezone, e.g. '2026-04-30T17:00:00Z'."),
  priority: z.enum(["LOW","MEDIUM","HIGH"]).optional(),
  assignee_owner_id: z.string().optional().describe("HubSpot owner id to assign. Omit to default to the connected user."),
  linked_records: z.array(z.object({
    object_type: z.enum(["contacts","companies","deals"]),
    record_id: z.string(),
  })).optional(),
}
```

## 6. Auth bootstrap

Standard pattern. Header: `Authorization: Bearer <access_token>` (Nango handles refresh).

Status mapping:
- 401 → `not_connected` (also signal Nango to refresh)
- 403 → `not_connected` with message "scope missing: <required_scope>" (parse from response body if available)
- 400/409/422 → `validation_failed`
- 429 → `rate_limited` with `retry_after`
- 5xx → `upstream_error`

Add a deep-link helper:
```ts
function dealLink(portalId: string, dealId: string) { return `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}` }
function contactLink(portalId: string, contactId: string) { return `https://app.hubspot.com/contacts/${portalId}/contact/${contactId}` }
```
…populate `hubspot_deep_link` in success responses (mirrors attio_deep_link / calcom_deep_link). Audit table column should be `hubspot_deep_link`.

## 7. Local state

- `agent_actions` (audit log), with column rename: `attio_object` → `hubspot_object`, `attio_record_id` → `hubspot_record_id`, `attio_deep_link` → `hubspot_deep_link`.
- **No domain caching.** HubSpot is the source of truth.

## 8. Test plan

**Unit:**
- `hubspot-client.test.ts` — status mapping, scope-missing 403 message extraction.
- `tools-search-contacts.test.ts` — filter array → request body shape; pagination cursor round-trip.
- `tools-update-deal-stage.test.ts` — validation_failed when stage doesn't belong to pipeline.
- `tools-describe-schema.test.ts` — properties shape + options unwrap for enumeration types.

**Integration:**
- `mcp-roundtrip.test.ts` — registerTool wiring + structuredContent matches outputSchema for each shape.

**E2E:**
- Docker-compose, mock bridge, exercise `_get_connection_status` + `_describe_schema(contacts)` round-trip.

Target: 16–20 tests (largest module → larger test set).

## 9. Implementation sequence

**Phase 1 — Scaffold (~1 hr)**
- [ ] `cp -r attio/ hubspot/`, rename. **Verify deep-link column rename in db.ts migrations.**
- [ ] Install + typecheck.
- [ ] `app.runtime.yaml` updated with all 12 tool names.

**Phase 2 — Client + connection (~1.5 hr)**
- [ ] `hubspot-client.ts` with Bearer header + status mapping + scope-missing parsing.
- [ ] Deep-link helpers.
- [ ] `hubspot_get_connection_status` end-to-end.

**Phase 3 — Schema discovery (~1 hr)**
- [ ] `hubspot_describe_schema` (single tool that takes `object_type`).
- [ ] `hubspot_list_pipelines` (separate tool because pipelines have a different shape).

**Phase 4 — Read tools (~2 hr)**
- [ ] `hubspot_search_contacts` (filter array → search body, cursor pagination).
- [ ] `hubspot_get_contact`.
- [ ] `hubspot_search_companies`.

**Phase 5 — Write tools — contacts + deals (~2.5 hr)**
- [ ] `hubspot_create_contact` + association payload.
- [ ] `hubspot_update_contact` (idempotency test).
- [ ] `hubspot_create_deal`.
- [ ] `hubspot_update_deal_stage` (validation when stage doesn't match pipeline).

**Phase 6 — Engagements (~1 hr)**
- [ ] `hubspot_add_note` (with parent association).
- [ ] `hubspot_create_task` (with multi-link associations).

**Phase 7 — Polish (~1.5 hr)**
- [ ] All gates green: typecheck + lint + test + build.
- [ ] Add 3 recipes to `MCP_RECIPES.md`:
  - "Find contacts in lifecycle 'opportunity' inactive 30+ days → log a re-engagement task."
  - "Add new lead via search-then-create → link to company → put in pipeline stage."
  - "Move a deal forward + log a note about the change."
- [ ] CLAUDE.md row + module pictograph updated.

## 10. Open questions for human review

- [ ] **OAuth scopes** — confirm the Nango HubSpot connector requests at minimum: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.schemas.contacts.read`, `crm.schemas.deals.read`, plus engagement scopes for notes/tasks. Some scopes are paid-tier-gated.
- [ ] **Should v1 expose tickets / engagements other than note+task?** I argue defer — Service Hub is a separate use case.
- [ ] **HubSpot Portal id** — is it returned by `/oauth/access-tokens/:token/info`, or do we have to derive it from a contact's URL? Need it for deep links.
- [ ] **Search filter operators** — confirm `BETWEEN` accepts `value` + `highValue` or `values: [low, high]`. Subagent verifies on day 1.
- [ ] **Association type ids** — HubSpot recently moved from string types like `"contact_to_company"` to numeric `associationTypeId`s. Confirm which API version we're hitting.
- [ ] **Brand color for `styles.css`** — HubSpot orange is `#FF7A59`. Suggest `oklch(0.71 0.16 35)`.
- [ ] **Rate-limit handling strategy** — when 429 hits in a multi-tool agent run, do we want the in-module client to auto-retry once (with `retry_after` sleep), or always surface to the agent? My take: surface always; the agent can decide. Confirm.
