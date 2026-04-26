# Instantly Module

A Holaboss module that wraps Instantly.ai (cold email automation) so the workspace agent can inspect campaigns, manage leads, and pause/resume sends.

## What it does

Exposes 11 MCP tools for reading and writing Instantly — campaigns, leads, stats, test sends. All data operations are pure proxy: Instantly is the source of truth. The module stores only an append-only audit log (`agent_actions`) of every tool call, which powers an Activity Feed UI.

## Tools

| Tool | Purpose |
|------|---------|
| `instantly_get_connection_status` | Check if Instantly is connected |
| `instantly_list_campaigns` | List campaigns with status, lead count, last activity |
| `instantly_get_campaign` | Fetch full campaign config (steps, schedule, mailboxes) |
| `instantly_create_campaign` | Create a barebones campaign (name + schedule) |
| `instantly_pause_campaign` | Pause an active campaign (idempotent) |
| `instantly_resume_campaign` | Resume a paused/draft campaign (idempotent) |
| `instantly_list_leads` | List leads in a campaign with per-lead status |
| `instantly_add_lead_to_campaign` | Bulk-add up to 100 leads to a campaign |
| `instantly_remove_lead_from_campaign` | Remove a lead (idempotent) |
| `instantly_get_campaign_stats` | Send / open / reply / bounce counts and rates |
| `instantly_send_test_email` | Send a test of one campaign step (preview only) |

## Architecture

Pure proxy (Shape B, external-API style). No local business data. The agent talks to Instantly through the Holaboss bridge, which holds the API key.

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
- `HOLABOSS_FRONTEND_URL` — frontend URL for the "Connect Instantly" link
- `DB_PATH` — SQLite file path (default: `./data/instantly.db`)
- `PORT` / `MCP_PORT` — web / MCP server ports
