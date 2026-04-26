# CLAUDE.md — holaboss-modules

## Project Overview

Independent Holaboss Modules repository. Each module is a self-contained TanStack Start application with its own MCP server, SQLite store, and (for publishing-style modules) a SQLite job queue and web UI. No shared packages — each module is fully independent (copy-paste over premature abstraction).

## Repository Layout

```
hola-boss-apps/
├── _template/        # Module template — copy this to create new modules
├── twitter/          # Twitter/X — content drafts, schedule, publish
├── linkedin/         # LinkedIn — content drafts, schedule, publish
├── reddit/           # Reddit — title + body + subreddit drafts, publish
├── gmail/            # Gmail — read threads, draft + send replies, CRM linking
├── github/           # GitHub — repo / commit / PR / release lookups (read-only)
├── sheets/           # Google Sheets — CRUD over rows + cells, contact-output sync
├── calcom/           # Cal.com — event types, bookings, availability, reschedule/cancel
├── attio/            # Attio CRM — people / companies / lists / notes / tasks
├── apollo/           # Apollo.io — prospecting (people/orgs), enrichment, sequence orchestration
├── zoominfo/         # ZoomInfo — B2B contact + company intelligence (read-only, licensed data)
├── instantly/        # Instantly — cold email campaigns + leads + idempotent pause/resume + test sends
├── hubspot/          # HubSpot CRM — contacts / companies / deals + pipelines + notes / tasks
├── create-hola-app/  # Scaffolding CLI for new modules
├── docs/             # Cross-module docs (convention, recipes, plans, dev guide)
└── scripts/          # Dev / deploy helpers
```

## Development Commands

All commands run from within a module directory (e.g., `cd twitter/`):

```bash
npm install           # Install dependencies
npm run dev           # Start web app + MCP server + worker (publishing modules)
npm run dev:web       # Start only the web frontend (Vite)
npm run dev:services  # Start only MCP server + queue worker
npm run build         # Production build (outputs to .output/)
npm start             # Run production build
npm run test:e2e      # Run e2e tests
npm run typecheck     # TypeScript strict type checking
npm run lint          # ESLint
npm run format        # Prettier
```

## Architecture

Each module runs two processes in dev:
- **Web app** (Vite, port 3000) — TanStack Start SSR + API routes + server functions
- **Services** (tsx, port 3099) — MCP server (SSE transport) and, for publishing modules, the SQLite job queue worker

In Docker, a single container runs both (no external dependencies like Redis).

### Key directories per module

```
src/
├── routes/                    # TanStack Router file-based routes
├── server/
│   ├── actions.ts             # Server functions (CRUD + publish + cancel)
│   ├── db.ts                  # SQLite database + migrations
│   ├── queue.ts               # SQLite job queue (publishing modules only)
│   ├── publisher.ts           # Platform-specific publish logic (publishing modules)
│   ├── mcp.ts                 # MCP server registration + transport
│   ├── tools.ts               # MCP tool definitions (calcom, attio)
│   ├── holaboss-bridge.ts     # Workspace context resolution + app-output sync
│   ├── bootstrap.ts           # Service init (idempotent)
│   └── start-services.ts      # CLI entry for services process
├── lib/
│   ├── types.ts               # Domain types + module config
│   └── utils.ts
└── styles.css                 # Tailwind + OKLch theme (brand colors per module)
```

### Module data models

| Module    | Primary entity         | Key fields                                                | Notes                              |
|-----------|------------------------|-----------------------------------------------------------|------------------------------------|
| Twitter   | `posts`                | `content`                                                 | 280-char limit                     |
| LinkedIn  | `posts`                | `content`                                                 | 3,000-char limit                   |
| Reddit    | `posts`                | `title` + `content` + `subreddit`                         | title 300, body 40,000             |
| Gmail     | `drafts`               | `to_email` + `subject` + `body` + `gmail_thread_id`       | reads from Gmail API               |
| GitHub    | (none — read-only)     | n/a                                                       | wraps GitHub REST                  |
| Sheets    | (Google as source)     | sheet/row/cell                                            | publishes contact outputs          |
| Cal.com   | `bookings`, `event_types` | `start_time`, `end_time`, `attendees`                  | wraps Cal.com v2 API               |
| Attio     | `people`/`companies`/`deals` (Attio as source) | dynamic via `describe_schema`            | upsert via `add_to_list`           |
| Apollo    | (Apollo as source)     | people / organizations / emailer_campaigns                | sequence add/remove requires Apollo master API key |
| ZoomInfo  | (ZoomInfo as source)   | contacts / companies / intent / org_chart                 | data licensed; populate user's own CRM only; in-process JWT cache |
| Instantly | (Instantly as source)  | campaigns / leads / stats                                 | wraps Instantly v2 API             |
| HubSpot   | (HubSpot as source)    | contacts / companies / deals (dynamic via `describe_schema`) | wraps HubSpot CRM v3 API; pipelines + stages enforced |

### Publishing module state machine (twitter / linkedin / reddit)

```
draft → queued → published
draft → scheduled → queued → published
  ↑         ↓
  └── cancelled
any → failed → (edit) → draft
```

`scheduled_at` is stored on the draft at create/update time; calling `*_publish_post` enqueues the job (immediately or delayed depending on `scheduled_at`).

### Gmail draft state machine

```
pending → queued → sent
pending → failed → (edit) → pending
pending → discarded
```

### SQLite job queue (publishing modules)

Replaces BullMQ/Redis. Three exported functions with stable interface:
- `enqueuePublish(payload)` — creates job (status: `waiting` or `delayed` if future `scheduled_at`)
- `getQueueStats()` — returns `{waiting, active, completed, failed, delayed}`
- `startWorker()` — polls every 3s, atomic claim with `UPDATE...RETURNING`, crash recovery on startup

### MCP tools — naming + description convention

All tools are module-prefixed snake_case: `twitter_create_post`, `linkedin_list_posts`, `attio_find_people`.

**Authoring rule:** every tool MUST follow [`docs/MCP_TOOL_DESCRIPTION_CONVENTION.md`](docs/MCP_TOOL_DESCRIPTION_CONVENTION.md). The agent only sees the tool name, description, input schema, and annotations — anything not in those four places is invisible at runtime.

Use `server.registerTool(name, { title, description, inputSchema, annotations }, handler)`. The legacy `server.tool(...)` overload is deprecated (`@modelcontextprotocol/sdk ≥ 1.27`).

## Creating a New Module

1. `cp -r _template/ <your-module>/`
2. `rm -rf <your-module>/node_modules && cd <your-module> && npm install`
3. Customize:
   - `src/lib/types.ts` — `MODULE_CONFIG` export, domain types
   - `src/server/mcp.ts` — replace the `module_*` tool name prefix; rewrite each tool description per the convention
   - `src/server/publisher.ts` (publishing modules) — class name + API logic
4. Update identifiers: `package.json` (name), `app.runtime.yaml`, `__root.tsx` (title), `api/health.ts` (module name), `index.tsx` (heading), `docker-compose.yml` (env vars)
5. Customize `styles.css` — brand `--primary` in OKLch for light + dark
6. Verify: `npm run typecheck` + `npm run test:e2e` + `npm run build`

## Docker

```bash
docker compose build
docker compose up -d
curl localhost:3000/api/health    # web app (port may differ; check compose file)
curl localhost:3099/mcp/health    # MCP server
```

Single container per module. Data persisted in `module-data` volume at `/app/data/module.db`.

### Sandbox deployment (`app.runtime.yaml`)

Modules are deployed into Holaboss sandbox containers via `app.runtime.yaml`. The sandbox runs on Docker overlay FS which has known issues with npm:

- **Always `rm -rf node_modules` before `npm install`** — overlay FS causes `ENOTEMPTY` errors
- **Use `--maxsockets 1`** — npm's parallel tar extraction races with overlay FS, causing `ENOENT` / `TAR_ENTRY_ERROR`. Serial downloads avoid this.
- **Standard setup command**: `rm -rf node_modules && npm install --maxsockets 1 && npm run build`
- **MCP path** must be `/mcp/sse` (not `/mcp`)
- **Start command** must launch both the web server and services process (`start-services.ts`)
- **Ports** are dynamically assigned by the in-sandbox runtime (HTTP from 18080+, MCP from 13100+); the `port: 3099` in `app.runtime.yaml` is a dev default that the runtime overrides via `PORT`/`MCP_PORT`.

## Key Conventions

- **No shared packages** — each module is fully self-contained; copy-paste is preferred over abstraction
- **MCP descriptions follow [`docs/MCP_TOOL_DESCRIPTION_CONVENTION.md`](docs/MCP_TOOL_DESCRIPTION_CONVENTION.md)** — non-negotiable
- **OKLch colors** — all theme colors use OKLch color space with CSS variables
- **Server functions** — use `createServerFn` from `@tanstack/react-start` for mutations
- **File-based routing** — `routeTree.gen.ts` auto-generates; don't edit manually
- **Biome-style linting** — no TypeScript enums, use `import type`, `for...of` over `.forEach`
- **SQLite only** — no external dependencies (Redis, Postgres, etc.) inside a module
