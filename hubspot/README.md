# HubSpot Module

A Holaboss module that gives the workspace agent CRM capabilities against the user's HubSpot portal via the @holaboss/bridge integration broker.

## What it does

Exposes 12 MCP tools for reading and writing HubSpot CRM — contacts, companies, deals, pipelines, notes, and tasks. All data operations are pure proxy: HubSpot is the source of truth. The module stores only an append-only audit log (`agent_actions`) of every tool call, which powers an Activity Feed UI.

## Tools

| Tool | Purpose |
|------|---------|
| `hubspot_get_connection_status` | Check if HubSpot is connected; report portal id and scopes |
| `hubspot_describe_schema` | List properties (incl. custom) for contacts / companies / deals |
| `hubspot_search_contacts` | Filter contacts by property values (lifecycle_stage, owner, ...) |
| `hubspot_get_contact` | Fetch a single contact with all properties |
| `hubspot_create_contact` | Create a contact with optional company / deal associations |
| `hubspot_update_contact` | Patch named properties on an existing contact |
| `hubspot_search_companies` | Filter companies by domain / industry / property |
| `hubspot_list_pipelines` | List deal pipelines and their stages |
| `hubspot_create_deal` | Create a deal in a pipeline + stage |
| `hubspot_update_deal_stage` | Move a deal to a different stage |
| `hubspot_add_note` | Attach a plaintext note to a contact / company / deal |
| `hubspot_create_task` | Create a task with deadline + assignee, optionally linked |

## Architecture

Pure proxy. No local business data. Audit log only.

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
- `HOLABOSS_FRONTEND_URL` — frontend URL for the "Connect HubSpot" link
- `DB_PATH` — SQLite file path (default: `./data/hubspot.db`)
- `PORT` / `MCP_PORT` — web / MCP server ports
