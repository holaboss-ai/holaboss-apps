/**
 * composio-connect
 *
 * Bootstrap a Composio connected account for a provider, then persist the
 * resulting connected_account_id into .composio-connections.json so the dev
 * broker can serve it.
 *
 * Usage:
 *   COMPOSIO_API_KEY=xxx pnpm composio:connect <toolkit-slug> [flags]
 *
 * Composio-managed toolkits (works with no extra flags):
 *   pnpm composio:connect gmail
 *   pnpm composio:connect github
 *
 * Toolkits without managed credentials — pass your own:
 *   # API-key auth (apollo, instantly, attio, …):
 *   pnpm composio:connect apollo --api-key apollo_xxx
 *
 *   # OAuth client credentials (some hubspot setups):
 *   pnpm composio:connect hubspot --oauth-client-id xxx --oauth-client-secret yyy
 *
 *   # Anything else — pass full credentials JSON:
 *   pnpm composio:connect zoominfo --credentials-json '{"username":"u","password":"p"}'
 *   pnpm composio:connect zoominfo --credentials-json @./zoominfo-creds.json
 *
 * Tip: if you don't pass credentials, the CLI tries Composio's managed auth
 * first. If Composio replies "Default auth config not found", it surfaces the
 * exact error with a hint about which flags to pass for that toolkit.
 *
 * Other flags:
 *   --user-id <id>     Composio user_id (default: holaboss-dev-$USER).
 *   --base-url <url>   Override Composio base URL (default backend.composio.dev).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  ManagedAuthNotAvailableError,
  type ComposioAuthScheme,
  createManagedConnectLink,
  waitForConnectedAccount,
} from "./composio-client.js"

const VALID_AUTH_SCHEMES: ReadonlyArray<ComposioAuthScheme> = [
  "OAUTH2", "OAUTH1", "API_KEY", "BASIC", "BEARER_TOKEN", "JWT", "BASIC_WITH_JWT", "NO_AUTH",
]

const CONNECTIONS_PATH = resolve(process.cwd(), ".composio-connections.json")

interface ParsedArgs {
  toolkitSlug: string
  userId: string
  baseUrl?: string
  apiKeyCred?: string
  oauthClientId?: string
  oauthClientSecret?: string
  credentialsJsonRaw?: string
  authScheme?: ComposioAuthScheme
}

function parseArgs(argv: Array<string>): ParsedArgs {
  const toolkitSlug = (argv[0] ?? "").trim()
  let userId = `holaboss-dev-${process.env.USER ?? "user"}`
  let baseUrl: string | undefined
  let apiKeyCred: string | undefined
  let oauthClientId: string | undefined
  let oauthClientSecret: string | undefined
  let credentialsJsonRaw: string | undefined
  let authScheme: ComposioAuthScheme | undefined

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === "--user-id" && next) { userId = next; i++ }
    else if (a === "--base-url" && next) { baseUrl = next; i++ }
    else if (a === "--api-key" && next) { apiKeyCred = next; i++ }
    else if (a === "--oauth-client-id" && next) { oauthClientId = next; i++ }
    else if (a === "--oauth-client-secret" && next) { oauthClientSecret = next; i++ }
    else if (a === "--credentials-json" && next) { credentialsJsonRaw = next; i++ }
    else if (a === "--auth-scheme" && next) {
      const upper = next.toUpperCase() as ComposioAuthScheme
      if (!VALID_AUTH_SCHEMES.includes(upper)) {
        throw new Error(`Invalid --auth-scheme '${next}'. Valid: ${VALID_AUTH_SCHEMES.join(", ")}`)
      }
      authScheme = upper
      i++
    }
  }

  return { toolkitSlug, userId, baseUrl, apiKeyCred, oauthClientId, oauthClientSecret, credentialsJsonRaw, authScheme }
}

function buildCustomCredentials(args: ParsedArgs): Record<string, unknown> | undefined {
  if (args.credentialsJsonRaw) {
    let raw = args.credentialsJsonRaw
    if (raw.startsWith("@")) {
      const path = resolve(process.cwd(), raw.slice(1))
      raw = readFileSync(path, "utf8")
    }
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch (e) {
      throw new Error(`--credentials-json failed to parse: ${(e as Error).message}`)
    }
  }
  if (args.apiKeyCred) return { api_key: args.apiKeyCred }
  if (args.oauthClientId || args.oauthClientSecret) {
    if (!args.oauthClientId || !args.oauthClientSecret) {
      throw new Error("--oauth-client-id and --oauth-client-secret must be passed together")
    }
    return { client_id: args.oauthClientId, client_secret: args.oauthClientSecret }
  }
  return undefined
}

const TOOLKIT_HINTS: Record<string, string> = {
  apollo: `Apollo uses an API key. Re-run with --api-key <your-apollo-key>.`,
  instantly: `Instantly uses an API key. Re-run with --api-key <your-instantly-key>.`,
  zoominfo:
    `ZoomInfo uses username + password OR username + clientId + privateKey (PKI). Re-run with ` +
    `--credentials-json '{"username":"...","password":"..."}' or ` +
    `--credentials-json '{"username":"...","clientId":"...","privateKey":"..."}'.`,
  hubspot:
    `HubSpot's managed auth should usually work. If your account requires a custom OAuth app, ` +
    `re-run with --oauth-client-id <id> --oauth-client-secret <secret>.`,
  attio: `Attio uses an API key. Re-run with --api-key <your-attio-key>.`,
  cal:
    `Cal.com (toolkit slug "cal") supports both OAuth2 and API key. Composio doesn't ship a managed Cal.com OAuth app, ` +
    `so pick one:\n` +
    `  • OAuth2 (recommended): create an OAuth client at https://app.cal.com → Settings → Developer → ` +
    `OAuth, then re-run with --oauth-client-id <id> --oauth-client-secret <secret> --auth-scheme OAUTH2.\n` +
    `  • API key: re-run with --api-key <your-calcom-api-key>.`,
}

function loadConnections(): Record<string, string> {
  if (!existsSync(CONNECTIONS_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONNECTIONS_PATH, "utf8")) as Record<string, string>
  } catch {
    return {}
  }
}

function saveConnections(connections: Record<string, string>): void {
  writeFileSync(CONNECTIONS_PATH, `${JSON.stringify(connections, null, 2)}\n`, "utf8")
}

function printUsage(): void {
  process.stderr.write(
    "Usage: pnpm composio:connect <toolkit-slug> [--api-key <key>] [--oauth-client-id <id> --oauth-client-secret <secret>] [--credentials-json '<json>' | --credentials-json @path/to/creds.json] [--user-id <id>] [--base-url <url>]\n",
  )
  process.stderr.write("Examples:\n")
  process.stderr.write("  pnpm composio:connect gmail                            # Composio-managed (OAuth)\n")
  process.stderr.write("  pnpm composio:connect github                           # Composio-managed (OAuth)\n")
  process.stderr.write("  pnpm composio:connect apollo --api-key apollo_xxx\n")
  process.stderr.write("  pnpm composio:connect hubspot --oauth-client-id ... --oauth-client-secret ...\n")
  process.stderr.write("  pnpm composio:connect zoominfo --credentials-json '{\"username\":\"u\",\"password\":\"p\"}'\n")
}

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY ?? ""
  if (!apiKey.trim()) {
    process.stderr.write("COMPOSIO_API_KEY is required\n")
    process.exit(1)
  }

  const args = parseArgs(process.argv.slice(2))
  if (!args.toolkitSlug) {
    printUsage()
    process.exit(1)
  }

  const customCredentials = buildCustomCredentials(args)
  const authMode = customCredentials ? "custom" : "managed"

  process.stdout.write(`\n[connect] Bootstrapping toolkit '${args.toolkitSlug}' (auth: ${authMode}, user '${args.userId}')…\n`)

  let link
  try {
    link = await createManagedConnectLink({
      apiKey,
      toolkitSlug: args.toolkitSlug,
      userId: args.userId,
      baseUrl: args.baseUrl,
      customCredentials,
      authScheme: args.authScheme,
    })
  } catch (e) {
    if (e instanceof ManagedAuthNotAvailableError) {
      const hint = TOOLKIT_HINTS[args.toolkitSlug.toLowerCase()] ??
        `Pass --api-key, --oauth-client-id+--oauth-client-secret, or --credentials-json.`
      process.stderr.write(`\n[connect] ${e.message}\n\n[connect] Hint: ${hint}\n`)
      process.exit(1)
    }
    throw e
  }

  process.stdout.write(`[connect] connectedAccountId: ${link.connectedAccountId}\n`)
  process.stdout.write(`[connect] Auth config: ${link.authConfigId}${link.authConfigCreated ? " (newly created)" : " (reused)"}\n`)
  if (link.expiresAt) process.stdout.write(`[connect] Link expires: ${link.expiresAt}\n`)
  process.stdout.write(`\n>>> Open this URL to complete OAuth: <<<\n${link.redirectUrl}\n\n`)

  process.stdout.write(`[connect] Waiting for OAuth completion (5-min timeout)…\n`)
  let lastStatus = ""
  const account = await waitForConnectedAccount({
    apiKey,
    connectedAccountId: link.connectedAccountId,
    baseUrl: args.baseUrl,
    timeoutMs: 300_000,
    intervalMs: 3_000,
    onTick: (status) => {
      if (status !== lastStatus) {
        process.stdout.write(`[connect] status: ${status}\n`)
        lastStatus = status
      }
    },
  })

  process.stdout.write(`[connect] ACTIVE — toolkit=${account.toolkitSlug ?? "?"} userId=${account.userId ?? "?"}\n`)

  const connections = loadConnections()
  const previous = connections[args.toolkitSlug]
  connections[args.toolkitSlug] = account.id
  saveConnections(connections)

  if (previous && previous !== account.id) {
    process.stdout.write(`[connect] Replaced previous connection for '${args.toolkitSlug}': ${previous} → ${account.id}\n`)
  } else if (previous) {
    process.stdout.write(`[connect] Refreshed existing connection for '${args.toolkitSlug}': ${account.id}\n`)
  } else {
    process.stdout.write(`[connect] Saved new connection for '${args.toolkitSlug}': ${account.id}\n`)
  }
  process.stdout.write(`[connect] Updated ${CONNECTIONS_PATH}\n`)
}

main().catch((e) => {
  process.stderr.write(`\n[connect] ERROR: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
