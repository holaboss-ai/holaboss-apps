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

### Auth + integration broker — `@holaboss/bridge` SDK (mandatory)

Modules NEVER hold raw third-party credentials, tokens, or JWTs. All provider API calls go through the Holaboss broker via `@holaboss/bridge`'s `createIntegrationClient(<provider>).proxy(...)`. The broker fronts **Composio** (`https://backend.composio.dev`), which holds the connected accounts and injects auth headers server-side.

Non-negotiable rules:

- The shim file in every module is `src/server/holaboss-bridge.ts` — exactly 36 lines, re-exports from `@holaboss/bridge`. **Do NOT hand-roll bridge logic.** If something is missing from the SDK, fix it upstream in `@holaboss/bridge`, never inline.
- Each module's `<svc>-client.ts` calls `createIntegrationClient("<provider-slug>")` and routes ALL data calls through `client.proxy({ method, endpoint, body })`. The endpoint is the full provider URL (e.g. `https://api.attio.com/v2/objects/people/records/query`). The broker prepends auth.
- Status mapping inside each module's client converts the proxy's `{ data, status, headers }` result to the canonical structured-error envelope: `{ code: "not_found"|"invalid_state"|"validation_failed"|"not_connected"|"rate_limited"|"upstream_error"|"internal", message, ...extra }`. See `docs/MCP_TOOL_DESCRIPTION_CONVENTION.md` §"Errors".

The runtime supplies `HOLABOSS_INTEGRATION_BROKER_URL` + `HOLABOSS_APP_GRANT` via env. Locally for testing, those point at the dev broker (next section).

### Live testing without desktop — `composio-dev-broker`

The repo ships a self-contained dev broker so you can exercise modules against real Composio + real third-party APIs WITHOUT booting the Holaboss desktop app or the in-sandbox runtime. See [`docs/LIVE_TESTING.md`](docs/LIVE_TESTING.md) for the full how-to.

5-step setup:

```bash
# 1. (root) install root tools
pnpm install

# 2. (terminal A — leave running) start the broker on :3099
COMPOSIO_API_KEY=cmp_xxx pnpm composio:broker

# 3. (terminal B) connect each provider once.
#    Composio-managed (most consumer toolkits — gmail, github, googlesheets):
COMPOSIO_API_KEY=cmp_xxx pnpm composio:connect gmail
#    B2B toolkits without managed creds need --api-key / --oauth-client-id+secret /
#    --credentials-json. The CLI auto-detects the auth scheme from credential
#    field names (api_key → API_KEY, client_id+client_secret → OAUTH2, etc.).
COMPOSIO_API_KEY=cmp_xxx pnpm composio:connect apollo --api-key apollo_xxx
COMPOSIO_API_KEY=cmp_xxx pnpm composio:connect attio  --api-key attio_xxx
COMPOSIO_API_KEY=cmp_xxx pnpm composio:connect instantly --api-key inst_xxx

# 4. run a module's live tests (path filter — see workspace section below)
pnpm --filter ./apollo run test:live
pnpm --filter ./hubspot run test:live
```

`.composio-connections.json` holds `{ <toolkit-slug>: <connected_account_id> }`, gitignored. The broker reads it on every request — no restart needed when you connect a new provider.

Each module has `test/live.test.ts` that's `describe.skipIf(!process.env.LIVE)` so it's a no-op in the regular `pnpm test` run. Live tests assert on shape only (never on data values, since the user's account contents drift). Writes are gated behind `LIVE_WRITE=1`; gmail-send and calcom-cancel are intentionally NOT wired into `LIVE_WRITE` (too easy to misuse from a test runner).

When a third-party plan-tier rejects a call (e.g. Apollo free plan blocks `/mixed_people/search`), the live test recognizes the message family and treats it as `[live] <tool>: SKIPPED — <provider> plan limit: ...` instead of failing — so the suite stays green on free-tier accounts.

### pnpm workspace

`pnpm-workspace.yaml` declares all 14 modules. From the repo root:

- **Name filter:** `pnpm --filter <name> run <script>` (e.g. `pnpm --filter hubspot run test:live`). Each shippable module's package `name` is just its directory name (`twitter`, `linkedin`, …, `hubspot`). The two non-shippable workspaces are exceptions: `_template/` is named `module-template`, and `create-hola-app/` keeps its own CLI name.
- **Path filter** (equivalent): `pnpm --filter ./<dir> run <script>`.
- `cd <dir> && pnpm <script>` always works regardless of filter syntax.

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
- **`@holaboss/bridge` SDK is mandatory** — no hand-rolled credential / JWT / broker URL logic in any module. All provider calls go through `createIntegrationClient(<slug>).proxy(...)`. The bridge talks to Composio; Nango is NOT used.
- **Composio toolkit slugs** for connect: `gmail`, `github`, `googlesheets`, `linkedin`, `twitter`, `reddit` are managed (no creds needed); `apollo`, `instantly`, `attio`, `calcom`, `zoominfo`, `hubspot` typically need custom credentials passed via `pnpm composio:connect`.
- **OKLch colors** — all theme colors use OKLch color space with CSS variables
- **Server functions** — use `createServerFn` from `@tanstack/react-start` for mutations
- **File-based routing** — `routeTree.gen.ts` auto-generates; don't edit manually
- **Biome-style linting** — no TypeScript enums, use `import type`, `for...of` over `.forEach`
- **SQLite only** — no external dependencies (Redis, Postgres, etc.) inside a module

## Marketplace registry — `marketplace.json` is the source of truth

[`marketplace.json`](marketplace.json) at the repo root is the single source of truth for the `/admin/apps` registry. It lists all 12 shippable modules with their description / category / tags / icon / provider_id / archive URL template. The schema is enforced via [`marketplace.schema.json`](marketplace.schema.json).

**Adding a new module** = add a directory + add an entry to `marketplace.json` (one PR, one diff). The manifest's `default_ref` gets bumped to the latest release tag on each push of `v*`.

**Manual `/admin/apps` CRUD still works** for one-offs (coming-soon placeholders, env-specific hiding, allowed_user_ids overrides). The sync endpoint preserves these by default — see [`docs/MARKETPLACE_SYNC_DESIGN.md`](docs/MARKETPLACE_SYNC_DESIGN.md) for the diff strategy.

## Release flows — legacy `v*` and changesets per-app

Two release flows run in parallel:

- **Legacy lockstep `v[0-9]*`** — pushing a tag like `v0.2.9` triggers `build-apps.yml` to build every module in `LEGACY_MODULES` and create a single bundled GitHub Release. This still drives every module that hasn't migrated to changesets.
- **Per-app changesets `<name>@<semver>`** — `twitter` is the pilot. Each module on this flow ships independently and gets its own GitHub Release.

Modules opted out of changesets are listed in `.changeset/config.json`'s `ignore` array — they ship via the legacy `v*` flow until explicitly migrated.

### Per-app changesets release — author playbook

For a code change to a module on the changesets flow (currently only `twitter`):

1. Make the code change on a feature branch.
2. `pnpm changeset` from the repo root. Pick the module (e.g. `twitter`), choose `patch` / `minor` / `major`, write a one-line summary. The CLI drops a `.changeset/<random-name>.md` file. Commit it alongside the code change.
3. Open the PR. Merge to `main` as usual.

Then CI takes over (see next section).

### Per-app changesets release — what CI does after merge

```
PR (code + .changeset/*.md) merged to main
        │
        ▼
release-changesets workflow runs `pnpm version-packages`:
  • bumps <name>/package.json version
  • regenerates <name>/CHANGELOG.md
  • rewrites marketplace.json's per-app default_ref
        │
        ▼
Pushes branch `changeset-release/main`, opens
"chore(release): version packages" PR (long-lived;
auto-updated on every subsequent main push that adds
more changesets).
        │
        │ merge the Version Packages PR
        ▼
release-changesets workflow runs again. `pnpm release`
(= `changeset tag`) creates and pushes git tag(s) like
`twitter@0.3.0` for each bumped package. changesets/action
also creates an empty GitHub Release per tag.
        │
        ▼
Final step in release-changesets dispatches build-apps.yml
via `gh workflow run build-apps.yml --ref <tag> -f modules=<name>`
for each newly published package. (See "known caveats" — the
explicit dispatch is necessary because tags pushed by
GITHUB_TOKEN don't trigger downstream workflows on their own.)
        │
        ▼
build-apps.yml runs against the tag ref:
  • builds <name> for linux-x64 / darwin-arm64 / win32-x64
  • uploads archives to the existing GitHub Release for that tag
```

### Repo-level requirements

Two repo settings must be on for the flow to run end-to-end. Both live under **Settings → Actions → General**:

- **Workflow permissions → Allow GitHub Actions to create and approve pull requests** — without this, `release-changesets` can push the `changeset-release/main` branch but the PR-create step 403s. The branch is still pushed; the playbook fallback is to open the PR manually:
  ```
  gh pr create --base main --head changeset-release/main \
      --title "chore(release): version packages" \
      --body "<paste the changeset summary>"
  ```
- **Allow GitHub Actions to create and approve pull requests** is also required for the Version Packages PR to be auto-opened on subsequent runs. Without it, every Version Packages PR has to be filed by hand.

### Known caveats

1. **`GITHUB_TOKEN`-pushed tags don't trigger downstream workflows.** GitHub's safeguard against recursive workflow loops. `release-changesets.yml` works around this with an explicit `gh workflow run build-apps.yml --ref <tag> -f modules=<name>` step that runs after `pnpm release` for each entry in `changesets/action`'s `publishedPackages` output. If that step ever breaks, archives won't end up on the GitHub Release; backfill manually:
   ```
   gh workflow run build-apps.yml --ref <tag> -f modules=<name>
   ```
2. **`changeset tag` will create tags for any package whose current `version` doesn't already have a matching git tag** — even when there's no pending `.changeset/*.md`. After landing the pilot, this auto-tagged `twitter@0.2.8` (the seed version) on a no-op release run. Harmless (the tag matches main HEAD; build-apps wasn't triggered for the same reason as caveat 1) but worth knowing.
3. **The CHANGELOG formatter pulls in `prettier-plugin-tailwindcss`** from `<module>/.prettierrc`. ESM resolution from inside changesets fails on it (`ERR_MODULE_NOT_FOUND`). Each module on changesets needs an `overrides` block in its `.prettierrc` that drops plugins for `CHANGELOG.md` — `twitter/.prettierrc` is the reference.

### Migrating a new module onto the changesets flow

1. Add `"version": "<current ref e.g. 0.2.8>"` to the module's `package.json`.
2. Add a `CHANGELOG.md` override to the module's `.prettierrc` (copy from `twitter/.prettierrc`).
3. Delete the module's name from the `ignore` array in `.changeset/config.json`.
4. Add a per-app `default_ref` override on its entry in `marketplace.json` pointing at the last legacy `v*` tag (e.g. `"default_ref": "v0.2.8"`); subsequent changesets releases rewrite it via `scripts/sync-marketplace-refs.mjs`.
5. Remove the module from `.github/workflows/build-apps.yml`'s `LEGACY_MODULES` env so a stray `v*` tag doesn't double-build it.

## Cross-module docs index

- [`docs/MCP_TOOL_DESCRIPTION_CONVENTION.md`](docs/MCP_TOOL_DESCRIPTION_CONVENTION.md) — how every tool's description / inputSchema / outputSchema / annotations / errors must read
- [`docs/MCP_RECIPES.md`](docs/MCP_RECIPES.md) — multi-tool workflow recipes the agent uses
- [`docs/APP_DEVELOPMENT_GUIDE.md`](docs/APP_DEVELOPMENT_GUIDE.md) — start-to-merge playbook for new modules
- [`docs/LIVE_TESTING.md`](docs/LIVE_TESTING.md) — connecting modules to real Composio without desktop
- [`docs/MARKETPLACE_SYNC_DESIGN.md`](docs/MARKETPLACE_SYNC_DESIGN.md) — design for the `/admin/apps` sync endpoint + button
- [`docs/plans/`](docs/plans/) — per-module implementation plans (apollo, zoominfo, instantly, hubspot)
