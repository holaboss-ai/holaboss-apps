# ZoomInfo Module

A Holaboss module that gives the workspace agent read-only B2B intelligence capabilities against the user's ZoomInfo account.

## What it does

Exposes 7 MCP tools for searching and enriching contacts and companies, fetching buyer intent signals, and listing executive teams. **Read-only** — the module never writes back to ZoomInfo. The module stores only an append-only audit log (`agent_actions`) of every tool call.

**Compliance note:** ZoomInfo data is licensed. Use only to populate the user's own CRM — do not export or share externally.

## Tools

| Tool | Purpose |
|------|---------|
| `zoominfo_get_connection_status` | Check whether ZoomInfo is connected |
| `zoominfo_search_contacts` | Search for contacts by persona criteria |
| `zoominfo_enrich_contact` | Get full contact details (email, phone) for one person — **consumes credits** |
| `zoominfo_search_companies` | Search for companies by firmographics |
| `zoominfo_enrich_company` | Get full company details (firmographics, tech stack) |
| `zoominfo_get_intent` | Buyer intent signals for one company |
| `zoominfo_get_org_chart` | C-suite + VP-level executives at a company |

## Architecture

Pure read-only proxy. JWT cache is in-process only — never persisted to disk (license requirement).

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
- `HOLABOSS_FRONTEND_URL` — frontend URL for the "Connect ZoomInfo" link
- `DB_PATH` — SQLite file path (default: `./data/zoominfo.db`)
- `PORT` / `MCP_PORT` — web / MCP server ports
