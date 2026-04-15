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