# Instantly Module — Implementation Plan

**Status:** draft, awaiting review
**Base shape:** B (attio-style) — pure proxy. NO local queue (Instantly has its own send pipeline).
**Estimated effort:** 1 day
**Companion docs:** [`MCP_TOOL_DESCRIPTION_CONVENTION.md`](../MCP_TOOL_DESCRIPTION_CONVENTION.md), [`APP_DEVELOPMENT_GUIDE.md`](../APP_DEVELOPMENT_GUIDE.md)

---

## 1. Goal

Wrap Instantly.ai (cold email automation) so an agent can:
- Inspect campaigns + their stats.
- Pause / resume campaigns.
- Add / remove leads from a campaign.
- Look up lead status within a campaign (replied? bounced? unsubscribed?).
- Test-send a campaign step to a specific recipient (dev/preview).

**Non-goals (defer):**
- Designing campaign step content (HTML editor flow — out of chat scope).
- Mailbox / sending account management (admin UI).
- Webhook ingest of reply events (we poll instead in v1).
- Local "preview before push" pending_leads table — defer until users ask for it.

## 2. User intents the module must serve

1. *"What campaigns do I have running, and how are they performing?"*
2. *"Pause my 'Q2 Outbound' campaign — I need to fix the subject line."*
3. *"Add these 30 leads from the Apollo search to my 'Cold Outreach v3' campaign."*
4. *"Did Bob from Acme reply to the campaign?"*
5. *"Send me a test email of step 2 in the 'Founder Intro' campaign so I can preview it."*
6. *"Remove anyone who's bounced from the campaign."*

## 3. API research (verify against current docs as step 1)

- **Base URL:** `https://api.instantly.ai/api/v2` (Instantly has v1 + v2; **use v2** — v1 is being deprecated).
- **Auth:** API key in header `Authorization: Bearer <api_key>`. Single-tenant per user.
- **Rate limits:** 10 RPS per workspace. Daily quota varies. Surface 429 as `rate_limited` with `retry_after`.
- **Pagination:** Most lists use `starting_after: <id>` cursor + `limit` (max 100).

Endpoints (verify against [developer.instantly.ai](https://developer.instantly.ai/) on day 1):

| Tool | Method + path |
|------|---------------|
| connection check | `GET /workspaces/current` |
| list campaigns | `GET /campaigns?limit=...&starting_after=...` |
| get campaign | `GET /campaigns/:id` |
| create campaign | `POST /campaigns` (name + minimal config) |
| pause campaign | `POST /campaigns/:id/activate` with `{active: false}` (or `/pause`) |
| resume campaign | `POST /campaigns/:id/activate` with `{active: true}` |
| list leads in campaign | `GET /campaigns/:id/leads` |
| add lead to campaign | `POST /campaigns/:id/leads` (single or bulk) |
| remove lead | `DELETE /campaigns/:id/leads/:lead_id` |
| campaign stats | `GET /campaigns/:id/analytics` |
| send test | `POST /campaigns/:id/test-send` |

## 4. Tool surface (10 tools)

| # | Tool | Annotations | One-line purpose |
|---|------|-------------|------------------|
| 1 | `instantly_get_connection_status` | read+open | Verify Instantly is connected. |
| 2 | `instantly_list_campaigns` | read+open | List all campaigns with name, status, lead count, last-activity. |
| 3 | `instantly_get_campaign` | read+open | Full campaign config: steps, schedule, sending accounts. |
| 4 | `instantly_create_campaign` | write+open | Create a barebones campaign (name + schedule). User configures steps via Instantly UI. |
| 5 | `instantly_pause_campaign` | write+open+idempotent | Pause an active campaign. Pausing an already-paused campaign is a no-op. |
| 6 | `instantly_resume_campaign` | write+open+idempotent | Resume a paused campaign. |
| 7 | `instantly_list_leads` | read+open | List leads in a campaign with status (active/replied/bounced/unsubscribed). Filter by status. |
| 8 | `instantly_add_lead_to_campaign` | write+open | Add one or many leads to a campaign. |
| 9 | `instantly_remove_lead_from_campaign` | write+open+idempotent | Remove a lead from a campaign. Idempotent. |
| 10 | `instantly_get_campaign_stats` | read+open | Send/open/reply/bounce counts + rates for one campaign. |
| 11 | `instantly_send_test_email` | write+open | Send a test of one campaign step to a recipient (dev/preview only). |

That's 11. If we have to cut one to stay near 10, drop `instantly_create_campaign` (campaign creation is largely a UI-driven design task; the agent can hand off).

## 5. Per-tool spec sketches

### `instantly_list_campaigns`

```ts
description: `List all Instantly campaigns ordered by created_at DESC.

When to use: discovery — "what campaigns do I have?", "which one is paused?".
Returns: array of { id, name, status: 'active' | 'paused' | 'draft' | 'completed', lead_count, last_activity_at }.`
inputSchema: {
  status: z.enum(["active","paused","draft","completed"]).optional().describe("Filter by lifecycle state."),
  limit: z.number().int().positive().max(100).optional(),
  starting_after: z.string().optional().describe("Cursor from previous page's last id."),
}
```

### `instantly_get_campaign`

```ts
outputSchema: {
  campaign: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["active","paused","draft","completed"]),
    schedule: z.object({
      timezone: z.string(),
      send_days: z.array(z.string()),    // e.g. ['Mon','Tue',...]
      send_window: z.object({ start: z.string(), end: z.string() }),  // '09:00', '17:00'
    }),
    steps: z.array(z.object({
      step_index: z.number(),
      delay_days: z.number(),
      subject: z.string().optional(),
      body_preview: z.string().optional(),  // first 200 chars
    })),
    sending_accounts: z.array(z.string()),  // email addresses doing the sending
  }),
  ...ToolSuccessMetaShape,
}
```

### `instantly_create_campaign`

```ts
description: `Create a new Instantly campaign with a name and basic schedule. Steps must be configured via the Instantly UI — this tool does NOT create email content.

When to use: the user wants to spin up a new campaign shell to fill in.
When NOT to use: to design the email sequence — Instantly's editor handles that better.
Returns: { campaign_id, name, status: 'draft' }. Status starts as 'draft'; it stays draft until a step is added in the UI.`
inputSchema: {
  name: z.string().describe("Campaign name shown in Instantly UI, e.g. 'Q2 Outbound — Eng Leaders'."),
  timezone: z.string().optional().describe("IANA timezone, e.g. 'America/New_York'. Default user's workspace timezone."),
  send_days: z.array(z.enum(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"])).optional().describe("Default ['Mon','Tue','Wed','Thu','Fri']."),
  send_window_start: z.string().optional().describe("HH:MM 24h, e.g. '09:00'. Default '09:00'."),
  send_window_end: z.string().optional().describe("HH:MM 24h, e.g. '17:00'. Default '17:00'."),
}
```

### `instantly_pause_campaign` / `instantly_resume_campaign`

```ts
// pause
description: `Pause an active Instantly campaign. Idempotent — pausing an already-paused campaign is a no-op.

When to use: stop sends mid-flight to fix subject line / unsubscribe a lead / change schedule.
Valid states: 'active' (no-ops on 'paused', returns isError on 'draft' or 'completed' — those can't transition to paused).
Returns: { campaign_id, status: 'paused' }.`
inputSchema: { campaign_id: z.string() }
outputSchema: { campaign_id: z.string(), status: z.literal("paused"), ...ToolSuccessMetaShape }
```

Resume mirrors pause.

### `instantly_list_leads`

```ts
description: `List leads in a campaign with their per-lead status.

When to use: "who's replied?", "show me bounces", or to find a specific lead's id before removing.
Returns: array of { lead_id, email, first_name, last_name, status: 'active' | 'replied' | 'bounced' | 'unsubscribed' | 'completed', added_at, last_contacted_at? }.`
inputSchema: {
  campaign_id: z.string(),
  status: z.enum(["active","replied","bounced","unsubscribed","completed"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
  starting_after: z.string().optional(),
}
```

### `instantly_add_lead_to_campaign`

```ts
description: `Add one or more leads to a campaign. Leads are matched by email — re-adding the same email is a no-op (returns added_count of unique new leads).

When to use: push prospects into outreach. Pair with apollo_search_people / zoominfo_enrich_contact.
Prerequisites: campaign_id from instantly_list_campaigns.
Returns: { campaign_id, added_count, skipped_count, lead_ids: [...] }.
Errors: { code: 'invalid_state' } if campaign is 'completed'.`
inputSchema: {
  campaign_id: z.string(),
  leads: z.array(z.object({
    email: z.string().describe("Lead email — primary key. Required."),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    company_name: z.string().optional(),
    custom_fields: z.record(z.string(), z.string()).optional().describe("Merge-tag values, e.g. { product: 'Holaboss' }. Used in {{custom.product}} placeholders."),
  })).min(1).max(100).describe("1-100 leads per call. For larger batches, paginate."),
}
outputSchema: {
  campaign_id: z.string(),
  added_count: z.number(),
  skipped_count: z.number(),
  lead_ids: z.array(z.string()),
  ...ToolSuccessMetaShape,
}
```

### `instantly_remove_lead_from_campaign`

Idempotent — removing a lead not in the campaign returns `removed: false` instead of an error.

### `instantly_get_campaign_stats`

```ts
outputSchema: {
  campaign_id: z.string(),
  sent: z.number(),
  delivered: z.number(),
  opened: z.number(),
  replied: z.number(),
  bounced: z.number(),
  unsubscribed: z.number(),
  open_rate: z.number(),       // 0..1
  reply_rate: z.number(),
  bounce_rate: z.number(),
  ...ToolSuccessMetaShape,
}
```

### `instantly_send_test_email`

```ts
description: `Send a test email of a specific campaign step to a recipient — for preview only. The recipient does NOT enter the campaign.

When to use: the user wants to QA a campaign step before activating.
Side effects: 1 email is sent immediately. Doesn't count toward campaign sending volume or stats.
Returns: { sent: true, to_email, step_index }.
Errors: { code: 'not_found' } if campaign or step doesn't exist.`
inputSchema: {
  campaign_id: z.string(),
  step_index: z.number().int().min(1).describe("Step number, 1-indexed. From instantly_get_campaign.steps[].step_index."),
  to_email: z.string().describe("Recipient. Use the user's own email for QA."),
}
```

## 6. Auth bootstrap

Standard pattern, attio-style. Header: `Authorization: Bearer <key>`.

Status mapping:
- 401/403 → `not_connected`
- 422/400 → `validation_failed` (use response body's error message)
- 429 → `rate_limited` with `retry_after`
- 5xx → `upstream_error`

## 7. Local state

- `agent_actions` (audit log) — copied from attio.
- **No domain tables in v1.**
- (Future v2 idea — if users want a local "preview & approve" stage before push: add `pending_leads` table mirroring twitter's draft pattern. Skip for v1.)

## 8. Test plan

**Unit:**
- `instantly-client.test.ts` — status mapping, cursor pagination shape.
- `tools-pause-campaign.test.ts` — idempotency on already-paused state.
- `tools-add-lead.test.ts` — added_count vs skipped_count math, max 100 enforcement.
- `tools-send-test.test.ts` — validation_failed on missing step_index.

**Integration:**
- `mcp-roundtrip.test.ts` — assert structuredContent matches outputSchema for stats + campaigns.

**E2E:**
- Docker-compose + mock bridge + `_get_connection_status` round-trip.

Target: 13–16 tests.

## 9. Implementation sequence

**Phase 1 — Scaffold (~1 hr)**
- [ ] `cp -r attio/ instantly/`, rename, install, typecheck.
- [ ] `app.runtime.yaml` updated.

**Phase 2 — Client + connection (~1 hr)**
- [ ] `instantly-client.ts` with `Authorization: Bearer` header + status mapping.
- [ ] `instantly_get_connection_status` end-to-end.

**Phase 3 — Read tools (~1.5 hr)**
- [ ] `instantly_list_campaigns` (with cursor pagination).
- [ ] `instantly_get_campaign`.
- [ ] `instantly_list_leads`.
- [ ] `instantly_get_campaign_stats`.

**Phase 4 — Write tools (~2 hr)**
- [ ] `instantly_create_campaign` (minimal — name + schedule only).
- [ ] `instantly_pause_campaign` + idempotency test.
- [ ] `instantly_resume_campaign`.
- [ ] `instantly_add_lead_to_campaign` + bulk math.
- [ ] `instantly_remove_lead_from_campaign`.
- [ ] `instantly_send_test_email`.

**Phase 5 — Polish (~1 hr)**
- [ ] All gates green.
- [ ] Add 2 recipes to `MCP_RECIPES.md`:
  - "Find leads via Apollo → push to Instantly campaign."
  - "Pause campaign → review bounces → remove bounced leads → resume."
- [ ] CLAUDE.md row added.

## 10. Open questions for human review

- [ ] **API v1 vs v2** — confirm we use v2. The exact URL path may be `/api/v2` or just `/v2`.
- [ ] **Pause/resume endpoint shape** — is it `POST /campaigns/:id/activate` with a body flag, or separate `/pause` + `/resume` endpoints? Subagent verifies on day 1.
- [ ] **Lead bulk-add limit** — confirm Instantly's per-request lead limit. I assumed 100; could be 50 or 1000.
- [ ] **Send test deliverability** — confirm test sends do NOT count toward daily quota or campaign stats. If they do, the tool's description must say so.
- [ ] **Should `instantly_create_campaign` be in v1?** I included it as #4 but flagged that it could be cut to keep surface ~10. User judgment call.
- [ ] **Brand color for `styles.css`** — Instantly's brand is bright orange-red. Suggest `oklch(0.65 0.22 32)` (close to Reddit but slightly more red).
