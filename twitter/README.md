# twitter

X (Twitter) module for Holaboss — compose, schedule, and publish tweets; manage DMs; resolve `@handle` → numeric `user_id`. Drafts are stored locally in SQLite; publishing flows through the platform's Composio bridge.

## MCP tools

All tool names are prefixed with `twitter_`:

| Tool | Purpose |
|------|---------|
| `twitter_create_post` | Create a draft tweet (≤280 chars). Optional `scheduled_at` for deferred publishing. |
| `twitter_update_post` | Edit a draft. |
| `twitter_publish_post` | Move a draft to `queued`/`scheduled`; the worker actually sends. |
| `twitter_cancel_publish` | Roll a `queued`/`scheduled` post back to `draft`. |
| `twitter_list_posts` | List posts filtered by status. |
| `twitter_list_recent_dm_events` | Inbox-wide DM activity with a deduped `senders` rollup (great for matching `@handle` → `user_id`). |
| `twitter_list_dms` | Read a specific 1:1 conversation by `participant_id`. |
| `twitter_send_dm` | Send a DM to a `participant_id`. |
| `twitter_lookup_user_by_handle` | Resolve `@handle` → `{ user_id, username, name? }` (exact match only). |

Tool descriptions follow [`docs/MCP_TOOL_DESCRIPTION_CONVENTION.md`](../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md).

## State machine

```
draft → queued → published
draft → scheduled → queued → published
  ↑         ↓
  └── cancelled
any → failed → (edit) → draft
```

`scheduled_at` is stored on the draft; `twitter_publish_post` is what enqueues the job (immediate or delayed depending on `scheduled_at`).

## Dev

```bash
pnpm --filter twitter dev          # web (3000) + MCP/worker (3099)
pnpm --filter twitter test         # unit + e2e
pnpm --filter twitter typecheck
pnpm --filter twitter build
```

For live tests against real Composio, see [`docs/LIVE_TESTING.md`](../docs/LIVE_TESTING.md). The `twitter` toolkit slug is Composio-managed — no API key required for `pnpm composio:connect twitter`.

## Releases

`twitter` ships through the **per-app changesets** flow rather than the legacy lockstep `v*` tags. Workflow:

1. Make a code change.
2. `pnpm changeset` — pick `twitter`, choose `patch`/`minor`/`major`, write a one-line summary. Commit the generated `.changeset/*.md` alongside your code.
3. PR merges to `main` → `release-changesets` workflow opens a "Version Packages" PR that bumps `twitter/package.json`, regenerates `CHANGELOG.md`, and rewrites the per-app `default_ref` in `marketplace.json`.
4. Merge that PR → tag `twitter@<version>` is pushed → `build-apps.yml` builds twitter for `linux-x64`, `darwin-arm64`, `win32-x64` and creates a per-app GitHub Release.

See [`.changeset/README.md`](../.changeset/README.md) for the full playbook.
