# App Publishing & Distribution

This document explains how Holaboss module apps are built, published, and consumed as **pre-built archives**.

## Overview

Each module (twitter, linkedin, reddit, gmail, github, sheets) is published as a self-contained `.tar.gz` archive per target platform. Sandboxes extract the archive and run directly — no `pnpm install`, no build step, no network access required at install time.

```
Developer pushes tag → GitHub Actions CI → GitHub Release with archives
                                                    ↓
                     Backend → download archive → sandbox → extract → start
```

## Archive Contents

Every archive is fully self-contained:

```
.output/
  server/
    index.mjs              # Nitro web server (port 3000)
    node_modules/
      better-sqlite3/      # Native addon (platform-specific)
      bindings/
      ...
  start-services.cjs       # MCP server + SQLite job queue worker (port 3099)
  node_modules/            # Copy of server/node_modules (for start-services.cjs)
  public/                  # Static web assets
  nitro.json
app.runtime.yaml           # Module runtime config (lifecycle, health, MCP)
package.json               # Module metadata
```

**Runtime requirements**: only `node` (v22+). No `pnpm`, `npm`, or source code needed.

**Size**: ~3-8 MB compressed per archive.

## Supported Platforms

Each module is built for three targets:

| Target | Used by | Native binary |
|--------|---------|---------------|
| `linux-x64` | Docker / Fly.io sandbox | ELF x86-64 |
| `darwin-arm64` | macOS desktop provider (Apple Silicon) | Mach-O arm64 |
| `win32-x64` | Windows desktop provider | PE32+ x64 |

Archives for the three platforms share identical JavaScript — they differ only in the `better-sqlite3` native binary. The CI build process downloads prebuilt binaries from [`WiseLibs/better-sqlite3` releases](https://github.com/WiseLibs/better-sqlite3/releases) for each target, so no actual cross-compilation happens.

## Publishing Flow

### Automated (recommended)

Tag a release and push:

```bash
git tag v1.2.0
git push origin v1.2.0
```

This triggers [`.github/workflows/build-apps.yml`](../.github/workflows/build-apps.yml), which:

1. **prepare** — Generates the build matrix (6 modules × 3 targets = 18 parallel jobs)
2. **build** — Each job runs `./scripts/build-archive.sh <module> --target <target>` on `ubuntu-latest`
3. **release** — Collects all archives and creates a GitHub Release with them attached

End-to-end: ~1 minute for all 18 archives.

### Manual trigger

From the GitHub Actions UI → **Build & Release App Archives** → **Run workflow**:

- **Modules**: comma-separated list (e.g. `twitter,linkedin`) or `all`
- **Targets**: comma-separated (e.g. `linux-x64`) or default (all three)

Manual runs upload archives as GitHub Actions artifacts (no GitHub Release created). Useful for testing.

### Local build

Build a single module locally for development or debugging:

```bash
# Build for current host
./scripts/build-archive.sh twitter

# Cross-build for Linux sandbox
./scripts/build-archive.sh twitter --target linux-x64

# Alpine Linux sandbox
./scripts/build-archive.sh twitter --target linux-x64-musl

# Windows
./scripts/build-archive.sh twitter --target win32-x64

# Custom output path
./scripts/build-archive.sh twitter --output /tmp/twitter.tar.gz
```

Archives land in `dist/` by default. The script:

1. Runs `pnpm install` (using lockfile if present)
2. Runs `pnpm run build` (vite + esbuild bundle of `start-services.ts`)
3. Ensures `.output/server/node_modules/better-sqlite3/` exists (bootstraps from root `node_modules` if Nitro didn't trace it)
4. Replaces the native binary with the target platform's prebuilt `.node` (if `--target` is cross-platform)
5. Copies `.output/server/node_modules` → `.output/node_modules` (for `start-services.cjs` to resolve)
6. Tars the result

## Consuming Archives

### Download URL format

```
https://github.com/holaboss-ai/holaboss-modules/releases/download/<version>/<module>-module-<target>.tar.gz
```

Example:
```
https://github.com/holaboss-ai/holaboss-modules/releases/download/v0.1.0/twitter-module-linux-x64.tar.gz
```

### Running an archive

```bash
# Download
curl -sL https://github.com/.../twitter-module-linux-x64.tar.gz -o twitter.tar.gz

# Extract into the app directory
mkdir -p /holaboss/workspace/{id}/apps/twitter
tar xzf twitter.tar.gz -C /holaboss/workspace/{id}/apps/twitter

# Run
cd /holaboss/workspace/{id}/apps/twitter
DB_PATH=./data/module.db PORT=18080 node .output/server/index.mjs &        # Web server
DB_PATH=./data/module.db MCP_PORT=13100 node .output/start-services.cjs &  # MCP + worker
```

### Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Web server port | `3000` |
| `MCP_PORT` | MCP SSE server port | `3099` |
| `DB_PATH` | SQLite database path | `./data/module.db` |
| `HOLABOSS_USER_ID` | Required by all modules | — |
| `WORKSPACE_API_URL` | Runtime API base URL | — |
| `HOLABOSS_WORKSPACE_ID` | Workspace identifier | — |
| `WORKSPACE_<MODULE>_INTEGRATION_ID` | Platform credential ID | — |
| `HOLABOSS_INTEGRATION_BROKER_URL` | Integration broker URL | — |
| `HOLABOSS_APP_GRANT` | App grant token | — |

See each module's `app.runtime.yaml` `env_contract` section for the full list.

### Health check

Each module exposes a health endpoint on its MCP port:

```bash
curl http://localhost:13100/mcp/health
```

## Versioning

Archive versions are tied to Git tags on the `holaboss-modules` repo. All modules in a given release share the same version — there's no per-module versioning yet.

To pin to a specific version in the backend:
```
APP_ARCHIVE_VERSION=v0.1.0
```

To always use the latest release:
```
APP_ARCHIVE_VERSION=latest  # resolved at runtime via GitHub API
```

## Troubleshooting

### Archive is stale / bundled binary is wrong platform

The `build-archive.sh` script runs the cross-compile step after building, but before copying `.output/server/node_modules` → `.output/node_modules`. If you modify the script, make sure this order is preserved — otherwise the copy contains the wrong binary.

Verify the binary in an archive:
```bash
tar xzf twitter-module-linux-x64.tar.gz
file .output/node_modules/better-sqlite3/build/Release/better_sqlite3.node
# Expect: ELF 64-bit LSB shared object, x86-64
```

### `Cannot find module 'better-sqlite3'` at runtime

This means `.output/node_modules/` is missing or doesn't contain `better-sqlite3`. Check:
1. The module's `better-sqlite3` dependency is listed in `package.json`
2. `pnpm install` succeeded during build
3. Either Nitro traced it into `.output/server/node_modules/` (if the web server imports `db.ts`) OR the script's fallback bootstrap ran (for modules where Nitro didn't trace)

### `Rollup failed to resolve import "X"` during build

pnpm's strict `node_modules` layout means transitive dependencies aren't hoisted to the project root. If a source file imports a package that's only a transitive dep (e.g. `zod` from `@modelcontextprotocol/sdk`, or `h3` from `nitro`), add it as a direct dependency in the module's `package.json`.

### CI build passes locally but fails in GitHub Actions

Check:
1. **Node version**: CI uses Node 24 (matching the Node used to generate `pnpm-lock.yaml`)
2. **Lockfile freshness**: any `package.json` change requires regenerating `pnpm-lock.yaml` (delete it and re-run `pnpm install`)
3. **Missing dependencies in `package.json`**: local builds may succeed because of residual `node_modules` state; do `rm -rf node_modules pnpm-lock.yaml && pnpm install` to reproduce a clean state

## Related Files

- [`scripts/build-archive.sh`](../scripts/build-archive.sh) — Build + packaging script
- [`.github/workflows/build-apps.yml`](../.github/workflows/build-apps.yml) — CI workflow
- [`CLAUDE.md`](../CLAUDE.md) — Repository overview and module conventions
- Module directories contain `app.runtime.yaml` (runtime lifecycle config) and `package.json` (dependencies)
