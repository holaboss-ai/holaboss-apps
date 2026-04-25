# create-hola-app

Scaffold a new Holaboss module.

```bash
npx create-hola-app my-first-app
```

Runs an interactive wizard by default (name, display name, git, install). Pass `-y` to accept all defaults.

## Options

| Flag | Description |
|------|-------------|
| `--template <spec>` | Local path or remote (`github:owner/repo/path`) |
| `--display <name>` | Display name (default: Title Case of app name) |
| `--no-git` | Skip `git init` |
| `--install` / `--no-install` | Install deps after scaffold (default: prompt) |
| `-y`, `--yes` | Accept all defaults, skip prompts |
| `-h`, `--help` | Show help |

## Examples

```bash
# Interactive
npx create-hola-app

# One-liner
npx create-hola-app my-first-app -y

# Custom display name
npx create-hola-app crm --display "CRM" -y

# Remote template (any giget-supported source)
npx create-hola-app foo --template github:holaboss-ai/hola-boss-apps/_template
```

## How it finds the template

Resolution order:
1. `--template <spec>` if provided (local path or `github:`/`gitlab:`/`bitbucket:`/URL)
2. Bundled `./template/` inside the published npm package
3. Sibling `../_template/` (dev mode, running from source inside `hola-boss-apps/`)
4. Fallback: `github:holaboss-ai/hola-boss-apps/_template` via giget

## Placeholder replacements

| Pattern | Replaced with |
|---------|---------------|
| `module-template` | kebab name (e.g. `my-first-app`) |
| `Module Template` | display name (e.g. `My First App`) |
| `"module_` (quoted) | `"<snake>_` — MCP tool prefixes only |
| `slug: "template"` | `slug: "<kebab>"` |
| `destination: "your-module"` | `destination: "<kebab>"` |

API fields like `module_id` / `module_resource_id` are preserved (the quote-prefix anchor protects them).

## Local development

```bash
cd hola-boss-apps/create-hola-app
npm install
node bin/index.js my-test --template ../_template -y
```

Or `npm link` once and then `create-hola-app` anywhere.

## Publishing

```bash
cd hola-boss-apps/create-hola-app
npm publish --access public
```

`prepack` copies `../_template/` into `./template/` so the tarball ships with the template bundled — no network required for `npx create-hola-app`.
