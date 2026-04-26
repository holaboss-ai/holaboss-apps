/**
 * composio-connect
 *
 * Bootstrap a Composio connected account for a provider, then persist the
 * resulting connected_account_id into .composio-connections.json so the dev
 * broker can serve it.
 *
 * Usage:
 *   COMPOSIO_API_KEY=xxx pnpm composio:connect <toolkit-slug> [--user-id <id>]
 *
 * Where <toolkit-slug> is whatever Composio's toolkit catalog uses
 * (e.g. "gmail", "github", "googlesheets", "hubspot", "apollo", "zoominfo",
 * "instantly", "calcom", "attio", "linkedin", "twitter", "reddit").
 *
 * The CLI:
 *   1. Calls createManagedConnectLink → prints the OAuth redirect URL.
 *   2. Polls Composio until the connected_account_id is ACTIVE.
 *   3. Writes the mapping { <slug>: <connected_account_id> } into
 *      .composio-connections.json (merging with any existing entries).
 *
 * Tip: a single .composio-connections.json file in the repo root serves the
 * whole workspace — connect each provider once, reuse across modules.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { createManagedConnectLink, waitForConnectedAccount } from "./composio-client.js"

const CONNECTIONS_PATH = resolve(process.cwd(), ".composio-connections.json")

function parseArgs(argv: Array<string>): { toolkitSlug: string; userId: string } {
  const toolkitSlug = (argv[0] ?? "").trim()
  let userId = `holaboss-dev-${process.env.USER ?? "user"}`
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--user-id" && argv[i + 1]) {
      userId = argv[i + 1]!
      i++
    }
  }
  return { toolkitSlug, userId }
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

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY ?? ""
  if (!apiKey.trim()) {
    process.stderr.write("COMPOSIO_API_KEY is required\n")
    process.exit(1)
  }

  const { toolkitSlug, userId } = parseArgs(process.argv.slice(2))
  if (!toolkitSlug) {
    process.stderr.write("Usage: pnpm composio:connect <toolkit-slug> [--user-id <id>]\n")
    process.stderr.write("Examples: gmail | github | googlesheets | hubspot | apollo\n")
    process.exit(1)
  }

  process.stdout.write(`\n[connect] Creating managed connect link for toolkit '${toolkitSlug}' (user '${userId}')…\n`)
  const link = await createManagedConnectLink({
    apiKey,
    toolkitSlug,
    userId,
  })
  process.stdout.write(`[connect] connectedAccountId: ${link.connectedAccountId}\n`)
  process.stdout.write(`[connect] Auth config: ${link.authConfigId}${link.authConfigCreated ? " (newly created)" : " (reused)"}\n`)
  if (link.expiresAt) process.stdout.write(`[connect] Link expires: ${link.expiresAt}\n`)
  process.stdout.write(`\n>>> Open this URL to complete OAuth: <<<\n${link.redirectUrl}\n\n`)

  process.stdout.write(`[connect] Waiting for OAuth completion (5-min timeout)…\n`)
  let lastStatus = ""
  const account = await waitForConnectedAccount({
    apiKey,
    connectedAccountId: link.connectedAccountId,
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
  const previous = connections[toolkitSlug]
  connections[toolkitSlug] = account.id
  saveConnections(connections)

  if (previous && previous !== account.id) {
    process.stdout.write(`[connect] Replaced previous connection for '${toolkitSlug}': ${previous} → ${account.id}\n`)
  } else if (previous) {
    process.stdout.write(`[connect] Refreshed existing connection for '${toolkitSlug}': ${account.id}\n`)
  } else {
    process.stdout.write(`[connect] Saved new connection for '${toolkitSlug}': ${account.id}\n`)
  }
  process.stdout.write(`[connect] Updated ${CONNECTIONS_PATH}\n`)
}

main().catch((e) => {
  process.stderr.write(`\n[connect] ERROR: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
