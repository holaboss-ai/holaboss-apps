# CLAUDE.md — holaboss-modules

## Project Overview

Independent Holaboss Modules repository. Each module is a self-contained TanStack Start application with its own MCP server, SQLite database, SQLite job queue, and web UI. No shared packages — each module is fully independent (copy-paste over premature abstraction).

## Repository Layout

```
holaboss-modules/
├── _template/     # Module template — copy this to create new modules
├── twitter/       # Twitter/X module
├── linkedin/      # LinkedIn module
└── reddit/        # Reddit module
```

## Development Commands

All commands run from within a module directory (e.g., `cd twitter/`):

```bash
npm install           # Install dependencies
npm run dev           # Start web app (:3000) + MCP server (:3099) + worker
npm run dev:web       # Start only the web frontend (Vite)
npm run dev:services  # Start only MCP server + job queue worker
npm run build         # Production build (outputs to .output/)
npm start             # Run production build
npm run test:e2e      # Run all e2e tests (13 tests expected)
npm run typecheck     # TypeScript strict type checking
npm run lint          # ESLint
npm run format        # Prettier
```

## Architecture

Each module runs two processes in dev:
- **Web app** (Vite, port 3000) — TanStack Start SSR + API routes + server functions
- **Services** (tsx, port 3099) — MCP server (SSE transport) + SQLite job queue worker

In Docker, a single container runs both (no external dependencies like Redis).

### Key directories per module

```
src/
├── routes/                    # TanStack Router file-based routes
│   ├── __root.tsx            # Root layout
│   ├── index.tsx             # Posts list page (/)
│   ├── posts.$postId.tsx     # Post editor/detail (/posts/$postId)
│   └── api/health.ts         # Health check endpoint
├── server/
│   ├── actions.ts            # Server functions (CRUD + publish + cancel)
│   ├── db.ts                 # SQLite database + migrations
│   ├── queue.ts              # SQLite job queue (enqueue, stats, worker)
│   ├── publisher.ts          # Platform-specific publish logic
│   ├── mcp.ts                # MCP server with platform-prefixed tools
│   ├── bootstrap.ts          # Service init (idempotent)
│   └── start-services.ts     # CLI entry for services process
├── lib/
│   ├── types.ts              # PostRecord, PublishJobPayload, PlatformConfig
│   └── utils.ts              # cn() utility
├── components/ui/
│   └── button.tsx            # CVA button component
├── router.tsx                # TanStack Router factory
├── routeTree.gen.ts          # Auto-generated (do not edit)
└── styles.css                # Tailwind + OKLch theme (brand colors per module)
```

### Data model differences

| Module | Fields | Char limits |
|--------|--------|-------------|
| Twitter | `content` | 280 |
| LinkedIn | `content` | 3,000 |
| Reddit | `title` + `content` + `subreddit` | title: 300, body: 40,000 |

### Post status state machine

```
draft → queued → published
draft → scheduled → queued → published
  ↑         ↓
  └── cancelled
any → failed → (edit) → draft
```

### SQLite job queue

Replaces BullMQ/Redis. Three exported functions with stable interface:
- `enqueuePublish(payload)` — creates job (status: `waiting` or `delayed` if future `scheduled_at`)
- `getQueueStats()` — returns `{waiting, active, completed, failed, delayed}`
- `startWorker()` — polls every 3s, atomic claim with `UPDATE...RETURNING`, crash recovery on startup

### MCP tool naming convention

All tools prefixed with module name: `twitter_create_post`, `linkedin_list_posts`, `reddit_publish_post`.

### Route behavior

- `/` — Posts list with status filter tabs, "+ New Post" button
- `/posts/$postId` — Editor if draft/failed, read-only detail if queued/scheduled/published

### Brand colors (in styles.css)

- **Twitter**: Default neutral (dark primary)
- **LinkedIn**: `#0A66C2` blue — `oklch(0.488 0.165 255.13)`
- **Reddit**: `#FF4500` orange-red — `oklch(0.636 0.248 31.68)`

## Creating a New Module

1. `cp -r _template/ <your-module>/`
2. `rm -rf <your-module>/node_modules && cd <your-module> && npm install`
3. Customize 3 core files:
   - `src/lib/types.ts` — `PlatformConfig` export
   - `src/server/mcp.ts` — tool name prefixes + platform-specific tools
   - `src/server/publisher.ts` — publisher class name + API logic
4. Update identifiers: `package.json` (name), `app.runtime.yaml`, `__root.tsx` (title), `api/health.ts` (module name), `index.tsx` (heading), `docker-compose.yml` (env vars), `queue.ts` (publisher import)
5. Update `test/e2e.test.ts` — describe names, publisher/config imports
6. If the data model differs from template (like Reddit's title/subreddit), also update: `db.ts` (schema), `actions.ts` (CRUD), routes (editor UI)
7. Customize `styles.css` — set brand `--primary` color in OKLch for light + dark modes
8. Verify: `npm run test:e2e` (13 tests pass) + `npm run build` (succeeds)

## Docker

```bash
docker compose build
docker compose up -d
curl localhost:8080/api/health    # web app
curl localhost:3099/mcp/health    # MCP server
```

Single container per module. Data persisted in `module-data` volume at `/app/data/module.db`.

### Sandbox deployment (app.runtime.yaml)

Modules are deployed into Holaboss sandbox containers via `app.runtime.yaml`. The sandbox runs on Docker overlay FS which has known issues with npm:

- **Always `rm -rf node_modules` before `npm install`** — overlay FS causes `ENOTEMPTY` errors when npm tries to remove existing `node_modules`
- **Use `--maxsockets 1`** — npm's parallel tar extraction races with overlay FS, causing `ENOENT` / `TAR_ENTRY_ERROR`. Serial downloads avoid this.
- **Standard setup command**: `rm -rf node_modules && npm install --maxsockets 1 && npm run build`
- **MCP path** must be `/mcp/sse` (not `/mcp`)
- **Start command** must launch both the web server and services process (`start-services.ts`)

## Key Conventions

- **No shared packages** — each module is fully self-contained; copy-paste is preferred over abstraction
- **OKLch colors** — all theme colors use OKLch color space with CSS variables
- **Server functions** — use `createServerFn` from `@tanstack/react-start` for mutations
- **File-based routing** — `routeTree.gen.ts` auto-generates on build/dev; don't edit manually
- **Biome-style linting** — no TypeScript enums, use `import type`, `for...of` over `.forEach`
- **SQLite for everything** — posts table + jobs table, no external dependencies
