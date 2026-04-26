# Apollo Module

A Holaboss module that gives the workspace agent prospecting + outbound capabilities against the user's Apollo.io account via the Holaboss bridge.

## What it does

Exposes 10 MCP tools for prospecting, enrichment, and sequence orchestration on Apollo.io. All data operations are pure proxy: Apollo is the source of truth. The module stores only an append-only audit log (`agent_actions`) of every tool call, which powers an Activity Feed UI.

## Tools

| Tool | Purpose |
|------|---------|
| `apollo_get_connection_status` | Verify Apollo is connected. |
| `apollo_search_people` | Find people by title, company, location, headcount. |
| `apollo_get_person` | Full details on one person id, including organization. |
| `apollo_enrich_person` | Find verified email/phone for a person. **Consumes credits.** |
| `apollo_search_organizations` | Find companies by industry, headcount, tech stack, geography. |
| `apollo_get_organization` | Full details on one organization id. |
| `apollo_list_sequences` | List your team's email sequences. |
| `apollo_add_to_sequence` | Push contacts into a sequence (idempotent). |
| `apollo_remove_from_sequence` | Remove contacts from a sequence (idempotent). |
| `apollo_list_emails_sent` | Recent send activity — sent/opened/replied/bounced. |

## Architecture

Pure proxy. No local business data — only an audit log.

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
- `HOLABOSS_FRONTEND_URL` — frontend URL for the "Connect Apollo" link
- `DB_PATH` — SQLite file path (default: `./data/apollo.db`)
- `PORT` / `MCP_PORT` — web / MCP server ports
