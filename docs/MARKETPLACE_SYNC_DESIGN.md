# Marketplace Sync — design

**Goal:** make `marketplace.json` (in this repo) the single source of truth for the admin app registry. A "Sync from repo" button on `/admin/apps` reconciles the live registry against the manifest in one click. A CI step on every release tag pushes the new `archive_version` automatically.

**Not goals:** no auto-mirror of every commit to main; admins still own visibility flags and `allowed_user_ids` overrides per environment (manifest is the structural truth, the registry is the runtime truth).

---

## Data flow

```
hola-boss-apps/marketplace.json   (this repo, source of truth)
        │
        │   on demand: admin clicks "Sync from repo"
        │   on release: CI POSTs after build-archive succeeds
        ▼
Hono oRPC  apps.syncFromRepo
        │  fetches raw.githubusercontent.com/<repo>/<ref>/marketplace.json
        │  diffs against live registry → { create[], update[], orphan[] }
        ▼
Python Marketplace  POST /api/v1/marketplace/admin/apps/sync
        │  validates payload, runs upsert per row, optionally hides orphans
        ▼
app_registry  (Supabase)
```

The frontend never talks to GitHub directly — Hono is the trusted intermediary that holds the GitHub PAT (or none, if the repo is public) and the marketplace API key.

---

## 1. Manifest contract — `marketplace.json`

Schema: `marketplace.schema.json` (this repo). Required top-level: `version`, `repo`, `default_ref`, `archive_url_template`, `apps`.

Per-app required: `name`, `description`, `category`, `path`, `provider_id`. Optional: `readme`, `icon`, `tags`, `default_ref` (per-app override), `archive_url_template` (override), `archive_version`, `credential_source`, `allowed_user_ids`, `is_hidden`, `is_coming_soon`.

**Resolution rules:**
- Per-app `default_ref` overrides manifest-level `default_ref`.
- Per-app `archive_url_template` overrides manifest-level template.
- `archive_version` defaults to the resolved `default_ref` if not set.
- `{ref}`, `{name}`, `{target}` placeholders in `archive_url_template` are substituted by the **sandbox runtime** at install time, not by the marketplace.

**Update cadence:**
- The `default_ref` at the top is bumped manually (or by CI) to the latest release tag.
- Per-app overrides exist for "pinned" apps that need a different version (e.g. one app has a regression at v0.2.1, pin it back to v0.2.0).

---

## 2. Backend — `POST /api/v1/marketplace/admin/apps/sync`

Add to `backend/src/api/v1/marketplace/routes/admin_apps.py`. New file is fine, but reuse the same router.

### Request

```py
class AppManifestEntry(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    description: str
    readme: str | None = None
    icon: str | None = None
    category: str = "general"
    tags: list[str] = Field(default_factory=list)
    path: str = "."
    default_ref: str | None = None  # per-app override
    archive_url_template: str | None = None  # per-app override
    archive_version: str | None = None
    provider_id: str | None = None
    credential_source: str | None = None
    allowed_user_ids: list[str] = Field(default_factory=list)
    is_hidden: bool = False
    is_coming_soon: bool = False


class AppManifestSyncPayload(BaseModel):
    version: int = 1
    repo: str  # e.g. "holaboss-ai/holaboss-apps"
    default_ref: str
    archive_url_template: str
    apps: list[AppManifestEntry]
    # Strategy for entries currently in the registry that are NOT in the manifest.
    # "ignore": leave them as-is (default, safest)
    # "hide":   set is_hidden=true (recommended for staging)
    # "delete": hard-delete (only for clean-slate environments)
    orphan_strategy: Literal["ignore", "hide", "delete"] = "ignore"
    # Allowed_user_ids and is_hidden are environment-specific. Manifest values
    # win unless preserve_overrides=true, in which case the existing registry
    # values are kept for these two fields when an entry already exists.
    preserve_overrides: bool = True
    dry_run: bool = False


class AppManifestSyncDiff(BaseModel):
    created: list[str]
    updated: list[str]
    unchanged: list[str]
    orphaned: list[str]
    # Field-level deltas for the updated entries — frontend renders this in the
    # confirmation modal so admins see exactly what's about to change.
    update_details: dict[str, dict[str, Any]] = Field(default_factory=dict)


class AppManifestSyncResponse(BaseModel):
    diff: AppManifestSyncDiff
    applied: bool  # false if dry_run=true
    manifest_version: int
    manifest_repo: str
    manifest_default_ref: str
```

### Handler

```py
@admin_apps_router.post("/admin/apps/sync", ...)
async def admin_sync_apps(request: Request, payload: AppManifestSyncPayload) -> AppManifestSyncResponse:
    repository = _registry(request)
    existing = {a.name: a for a in repository.list_all(include_hidden=True)}
    manifest = {a.name: a for a in payload.apps}

    diff = AppManifestSyncDiff(created=[], updated=[], unchanged=[], orphaned=[])

    for name, entry in manifest.items():
        # Resolve per-app overrides over manifest defaults.
        record = AppTemplateMetadata.model_validate({
            "name": entry.name,
            "description": entry.description,
            "readme": entry.readme,
            "icon": entry.icon,
            "category": entry.category,
            "tags": entry.tags,
            "repo": payload.repo,
            "path": entry.path,
            "default_ref": entry.default_ref or payload.default_ref,
            "archive_url_template": entry.archive_url_template or payload.archive_url_template,
            "archive_version": entry.archive_version or entry.default_ref or payload.default_ref,
            "provider_id": entry.provider_id,
            "credential_source": entry.credential_source,
            "allowed_user_ids": entry.allowed_user_ids,
            "is_hidden": entry.is_hidden,
            "is_coming_soon": entry.is_coming_soon,
        })

        prev = existing.get(name)
        if prev is None:
            diff.created.append(name)
        else:
            # Honor preserve_overrides for these two env-scoped fields.
            if payload.preserve_overrides:
                record.allowed_user_ids = prev.allowed_user_ids
                record.is_hidden = prev.is_hidden
            delta = _shallow_diff(prev, record)
            if delta:
                diff.updated.append(name)
                diff.update_details[name] = delta
            else:
                diff.unchanged.append(name)

        if not payload.dry_run:
            repository.upsert(record)

    for name, prev in existing.items():
        if name in manifest:
            continue
        diff.orphaned.append(name)
        if payload.dry_run:
            continue
        if payload.orphan_strategy == "hide" and not prev.is_hidden:
            repository.upsert(prev.model_copy(update={"is_hidden": True}))
        elif payload.orphan_strategy == "delete":
            repository.delete(name)

    return AppManifestSyncResponse(
        diff=diff,
        applied=not payload.dry_run,
        manifest_version=payload.version,
        manifest_repo=payload.repo,
        manifest_default_ref=payload.default_ref,
    )
```

`_shallow_diff(prev, next)` returns `{ field: { from, to } }` over a fixed list of fields — the frontend pretty-prints this.

### Tests (in `backend/test/api/v1/marketplace/test_admin_apps.py`)

- `dry_run=True` returns the diff but does NOT call repository.upsert.
- `created` populated when manifest has new app.
- `updated` populated + `update_details` lists exact field changes.
- `unchanged` populated for byte-equal entries.
- `orphan_strategy="hide"` sets `is_hidden=True` on registry entries not in manifest; `"ignore"` leaves them alone; `"delete"` removes them.
- `preserve_overrides=True` (default) keeps the existing registry's `allowed_user_ids` + `is_hidden` even when manifest disagrees.

---

## 3. Hono oRPC procedure — `apps.syncFromRepo`

Add to `frontend/packages/api/src/routers/apps.ts`:

```ts
const appsSyncInputSchema = z.object({
  // Override the default ref to fetch the manifest from. Useful for testing
  // an unreleased manifest in staging.
  ref: z.string().optional(),
  orphan_strategy: z.enum(["ignore", "hide", "delete"]).optional(),
  preserve_overrides: z.boolean().optional(),
  dry_run: z.boolean().optional(),
})

export const appsRouter = {
  // ...existing listAdmin / create / update / delete...

  syncFromRepo: adminProcedure
    .input(appsSyncInputSchema)
    .handler(async ({ context, input }) => {
      const env = context.env as Env
      const ref = input.ref ?? "main"
      const manifestUrl = `https://raw.githubusercontent.com/holaboss-ai/holaboss-apps/${ref}/marketplace.json`

      const ghRes = await fetch(manifestUrl, {
        headers: env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` }
          : {},
      })
      if (!ghRes.ok) {
        throw externalError(ghRes.status, await ghRes.text(), {
          method: "GET", path: manifestUrl,
        })
      }
      const manifest = await ghRes.json()

      const baseUrl = marketplaceBaseUrl(env)
      const apiKey = env.AGENT_SERVICE_API_KEY
      const syncRes = await fetch(`${baseUrl}/api/v1/marketplace/admin/apps/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({
          ...manifest,
          orphan_strategy: input.orphan_strategy ?? "ignore",
          preserve_overrides: input.preserve_overrides ?? true,
          dry_run: input.dry_run ?? false,
        }),
      })
      if (!syncRes.ok) {
        throw externalError(syncRes.status, await syncRes.text(), {
          method: "POST", path: "/admin/apps/sync",
        })
      }
      return appManifestSyncResponseSchema.parse(await syncRes.json())
    }),
}
```

Hono needs `GITHUB_TOKEN` env var if `holaboss-ai/holaboss-apps` is private (currently public, so unauthenticated raw.githubusercontent.com works at 60 req/hr — fine).

---

## 4. Frontend — `/admin/apps` "Sync from repo" button

Files to edit:

**`apps/web/src/features/admin/api/use-apps.ts`** — add the hook:
```ts
export function useSyncAppsFromRepo() {
  return useMutation(orpc.apps.syncFromRepo.mutationOptions({
    onSuccess: async (data) => {
      await queryClient.invalidateQueries(orpc.apps.listAdmin.queryOptions())
      toast.success(
        `Synced: ${data.diff.created.length} created, ` +
        `${data.diff.updated.length} updated, ` +
        `${data.diff.orphaned.length} orphaned.`
      )
    },
    onError: (e: Error) => toast.error(`Sync failed: ${e.message}`),
  }))
}
```

**`apps/web/src/features/admin/components/sync-from-repo-dialog.tsx`** (new) — the diff modal:

1. On open, call `syncFromRepo({ dry_run: true })` → render diff in three sections (Created / Updated / Orphaned), each collapsible.
2. For Updated, show the `update_details` field-level diff inline (red strikethrough → green).
3. Two switches: "Hide orphaned apps" (maps to `orphan_strategy: 'hide'` when on, else `'ignore'`) and "Preserve env overrides" (default on, maps to `preserve_overrides`).
4. "Apply" button → call `syncFromRepo({ dry_run: false, orphan_strategy, preserve_overrides })`.

**`apps/web/src/app/routes/admin/apps.tsx`** — add the button next to existing "+ Add App":

```tsx
<Button variant="outline" onClick={() => setSyncOpen(true)}>
  <RefreshIcon className="size-4" />
  Sync from repo
</Button>
```

**Permissions:** `adminProcedure` already gates this — no UI auth changes needed.

---

## 5. CI — auto-sync on release tag

`hola-boss-apps/.github/workflows/build-apps.yml` — add a job after `release`:

```yaml
sync-marketplace:
  needs: release
  if: startsWith(github.ref, 'refs/tags/v')
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - name: Bump default_ref in marketplace.json to this tag
      run: |
        TAG="${GITHUB_REF#refs/tags/}"
        node -e "
          const fs = require('fs');
          const m = JSON.parse(fs.readFileSync('marketplace.json', 'utf8'));
          m.default_ref = '$TAG';
          fs.writeFileSync('marketplace.json', JSON.stringify(m, null, 2) + '\n');
        "

    - name: POST manifest to marketplace
      run: |
        curl -fsSL -X POST "${MARKETPLACE_API_URL}/api/v1/marketplace/admin/apps/sync" \
          -H "X-API-Key: ${MARKETPLACE_ADMIN_KEY}" \
          -H "Content-Type: application/json" \
          --data-binary @marketplace.json \
          -d '{"orphan_strategy":"ignore","preserve_overrides":true,"dry_run":false}'
      env:
        MARKETPLACE_API_URL: ${{ secrets.MARKETPLACE_API_URL }}
        MARKETPLACE_ADMIN_KEY: ${{ secrets.MARKETPLACE_ADMIN_KEY }}

    - name: Commit bumped manifest back to main
      run: |
        git config user.name "github-actions[bot]"
        git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
        git checkout main
        cp marketplace.json /tmp/manifest.json
        git pull --rebase origin main
        cp /tmp/manifest.json marketplace.json
        git add marketplace.json
        git diff --quiet --cached || (
          git commit -m "chore(marketplace): bump default_ref to ${GITHUB_REF#refs/tags/}"
          git push origin main
        )
```

Two new secrets needed in the repo settings: `MARKETPLACE_API_URL`, `MARKETPLACE_ADMIN_KEY`.

The `curl -d` after `--data-binary @file` is wrong (overrides the file body) — actual implementation should jq-merge the orphan_strategy/preserve_overrides fields into the manifest JSON before POSTing. Spelled out for clarity above; in practice:

```bash
jq '. + {"orphan_strategy":"ignore","preserve_overrides":true,"dry_run":false}' \
  marketplace.json > /tmp/payload.json
curl -fsSL -X POST ... --data-binary @/tmp/payload.json
```

---

## 6. Rollout order

1. **Now**: land `marketplace.json` + this design doc in `hola-boss-apps`. (No behavior change yet.)
2. **Backend PR**: `POST /admin/apps/sync` endpoint + tests. Land alone, ship to staging.
3. **Frontend PR**: `apps.syncFromRepo` oRPC + dialog component + button on admin page. Land + ship.
4. **Manual smoke**: from staging admin, click "Sync from repo" → confirm 12 apps appear with correct fields. Iterate on any missing/wrong metadata in `marketplace.json` and re-sync.
5. **CI auto-sync**: enable the workflow step on `hola-boss-apps`. From v0.2.2 onward, releases auto-bump `default_ref` and propagate.
6. **Cleanup**: delete any pre-existing `app_registry` rows that were manually created and don't match a manifest entry. Or set `orphan_strategy: "hide"` on next sync.

---

## Open questions

- [ ] **Repo URL for archives**: the current remote is `imerch-ai/holaboss-modules` (which redirects to `holaboss-ai/holaboss-apps`). The manifest uses the new canonical name. Confirm GitHub redirects download URLs for tagged releases (they should), or update `git remote set-url` to drop the redirect dependency.
- [ ] **Where do icons live?** `marketplace.json` ships icon strings (e.g. `"twitter"`). Does the frontend resolve these to SVGs from a static asset bundle, or does the manifest need full URLs / data URIs? Confirm with frontend team and update schema.
- [ ] **`is_hidden` semantics on first sync**: a brand-new entry with `is_hidden: false` in manifest will become visible on staging immediately. If staging needs a soft-launch window, the initial sync should pass `dry_run: true` → admin manually flips visibility per env.
- [ ] **README inlining**: should the sync also fetch each module's `README.md` from the repo and inline it into `readme`? Saves a click for end users browsing the marketplace, but bloats the manifest payload. Defer to v2.
