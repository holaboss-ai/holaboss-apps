# Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to drive **per-app** releases. Each module has its own version stream and its own GitHub Release — when twitter ships a fix, only twitter rebuilds and only twitter's `default_ref` in `marketplace.json` advances.

## Pilot scope

Only **twitter** is currently driven by changesets. Every other module remains on the legacy lockstep `v*` tag flow (`build-apps.yml`'s `push: tags: ['v*']` trigger). Once the twitter pilot is validated end-to-end, modules will be removed from `.changeset/config.json`'s `ignore` list one at a time and migrated over.

## Authoring a changeset

After a code change to twitter:

```bash
pnpm changeset
```

Pick `twitter`, the bump type (`patch` / `minor` / `major`), and write a one-line summary. The CLI drops a `.changeset/<random-name>.md` file — commit it together with your code change.

`patch` for bug fixes, `minor` for new MCP tools or non-breaking features, `major` for breaking changes (tool removals, schema changes, env-var renames).

## Release flow (CI-driven)

1. PR with code change + `.changeset/*.md` merges to `main`.
2. The `release-changesets` workflow opens (or updates) a long-lived **"Version Packages"** PR that runs `changeset version` — bumps each affected app's `package.json`, regenerates `CHANGELOG.md`, deletes consumed `.changeset/*.md` files, and rewrites the per-app `default_ref` in `marketplace.json` via `scripts/sync-marketplace-refs.mjs`.
3. Merging that PR runs `changeset tag`, which creates a git tag like `twitter@0.3.0` per bumped app.
4. The tag triggers `build-apps.yml`, which builds **only that app** and creates a per-app GitHub Release.
5. The same workflow (or a follow-up) bumps the `default_ref` for that app in `marketplace.json` and calls the backend's `POST /api/v1/marketplace/admin/apps/sync` so the registry picks up the new ref.

## Why `ignore` for everything except twitter

Changesets `ignore` is documented as a short-term hatch — packages stay opted-out of versioning until they're explicitly removed from the list. That's exactly what we want during the pilot: keep the blast radius of a possibly-broken changesets setup limited to twitter while the other 12 apps continue using `build-apps.yml`'s lockstep `v*` trigger.

When migrating an app off the `ignore` list:

1. Add `"version": "<current ref e.g. 0.2.8>"` to the app's `package.json`.
2. Delete the app's name from the `ignore` array in `.changeset/config.json`.
3. Add a per-app `default_ref` override on its entry in `marketplace.json` pointing at the last legacy `v*` tag (e.g. `"default_ref": "v0.2.8"`); subsequent changesets releases will rewrite it via `scripts/sync-marketplace-refs.mjs`.
4. Remove the app from `.github/workflows/build-apps.yml`'s `LEGACY_MODULES` env so a stray `v*` tag doesn't double-build it.
