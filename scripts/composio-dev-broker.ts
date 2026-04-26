/**
 * composio-dev-broker
 *
 * Standalone HTTP server that lets module live tests exercise real Composio
 * WITHOUT booting the Holaboss desktop app or the in-sandbox runtime.
 *
 * It speaks the @holaboss/bridge SDK shape — modules' SDK calls
 * `${HOLABOSS_INTEGRATION_BROKER_URL}/broker/proxy` with `{ grant, provider,
 * request }` and this broker forwards to Composio's
 * `/api/v3/tools/execute/proxy` using the `connected_account_id` mapped per
 * provider in `.composio-connections.json`.
 *
 * Usage:
 *   COMPOSIO_API_KEY=xxx pnpm composio:broker
 *   # then in another terminal:
 *   HOLABOSS_INTEGRATION_BROKER_URL=http://localhost:3099 \
 *   HOLABOSS_APP_GRANT=grant:dev:0:0 \
 *   pnpm --filter apollo run test:live
 *
 * Bootstrap a connected account for a provider with `pnpm composio:connect`
 * (see scripts/composio-connect.ts).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { proxyProviderRequest } from "./composio-client.js"

const PORT = Number(process.env.COMPOSIO_DEV_BROKER_PORT ?? 3099)
const API_KEY = process.env.COMPOSIO_API_KEY ?? ""
const CONNECTIONS_PATH = resolve(process.cwd(), ".composio-connections.json")

if (!API_KEY.trim()) {
  process.stderr.write("COMPOSIO_API_KEY is required\n")
  process.exit(1)
}

interface ProxyBody {
  grant?: string
  provider?: string
  request?: { method?: string; endpoint?: string; body?: unknown }
}

function loadConnections(): Record<string, string> {
  if (!existsSync(CONNECTIONS_PATH)) return {}
  try {
    const raw = readFileSync(CONNECTIONS_PATH, "utf8")
    return JSON.parse(raw) as Record<string, string>
  } catch (e) {
    process.stderr.write(`[composio-dev-broker] Failed to read ${CONNECTIONS_PATH}: ${(e as Error).message}\n`)
    return {}
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Array<Buffer> = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString()
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

function logLine(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)

  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      send(res, 200, { status: "ok", connections: Object.keys(loadConnections()) })
      return
    }

    if (req.method === "GET" && url.pathname === "/") {
      const connections = loadConnections()
      const rows = Object.entries(connections)
        .map(([provider, id]) => `<tr><td>${provider}</td><td><code>${id}</code></td></tr>`)
        .join("\n") || `<tr><td colspan="2"><em>(none — run pnpm composio:connect &lt;toolkit&gt;)</em></td></tr>`
      const html = `<!doctype html><meta charset="utf-8"><title>composio-dev-broker</title>
<style>body{font:14px/1.5 system-ui;padding:24px;max-width:720px}code{font:12px ui-monospace}table{border-collapse:collapse}td{border:1px solid #ddd;padding:6px 12px}</style>
<h1>composio-dev-broker</h1>
<p>Listening on <code>:${PORT}</code>. Connections file: <code>${CONNECTIONS_PATH}</code></p>
<h2>Connected accounts</h2>
<table><thead><tr><th>provider</th><th>connected_account_id</th></tr></thead><tbody>${rows}</tbody></table>
<h2>How to use</h2>
<pre>HOLABOSS_INTEGRATION_BROKER_URL=http://localhost:${PORT}
HOLABOSS_APP_GRANT=grant:dev:0:0
pnpm --filter &lt;module&gt; run test:live</pre>`
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
      return
    }

    // The SDK calls this — must accept the exact bridge shape.
    if (req.method === "POST" && url.pathname === "/broker/proxy") {
      const raw = (await readJson(req)) as ProxyBody
      const provider = (raw.provider ?? "").trim()
      const request = raw.request ?? {}
      const method = (request.method ?? "GET").toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
      const endpoint = String(request.endpoint ?? "")

      if (!provider) {
        send(res, 400, { error: "missing provider" })
        return
      }
      if (!endpoint) {
        send(res, 400, { error: "missing request.endpoint" })
        return
      }

      const connections = loadConnections()
      const connectedAccountId = connections[provider]
      if (!connectedAccountId) {
        // Surface as 401 in the proxy response so the SDK maps it to not_connected.
        logLine(`PROXY ${provider} ${method} ${endpoint} → 401 (no connection — run pnpm composio:connect ${provider})`)
        send(res, 200, {
          data: { error: `No ${provider} integration configured. Connect via Integrations settings.` },
          status: 401,
          headers: {},
        })
        return
      }

      try {
        const result = await proxyProviderRequest({
          apiKey: API_KEY,
          connectedAccountId,
          method,
          endpoint,
          body: request.body,
        })
        logLine(`PROXY ${provider} ${method} ${endpoint} → ${result.status}`)
        send(res, 200, result)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        logLine(`PROXY ${provider} ${method} ${endpoint} → ERROR ${msg}`)
        // Surface as a 502 inside the proxy envelope so the SDK can map to upstream_error.
        send(res, 200, {
          data: { error: msg },
          status: 502,
          headers: {},
        })
      }
      return
    }

    send(res, 404, { error: "not found" })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logLine(`UNHANDLED ${req.method} ${url.pathname} → 500 ${msg}`)
    send(res, 500, { error: msg })
  }
})

server.listen(PORT, () => {
  logLine(`composio-dev-broker listening on http://localhost:${PORT}`)
  logLine(`Connections file: ${CONNECTIONS_PATH}`)
  const conns = loadConnections()
  if (Object.keys(conns).length === 0) {
    logLine(`No connections yet. Run: pnpm composio:connect <toolkit-slug>`)
  } else {
    logLine(`Loaded ${Object.keys(conns).length} connection(s): ${Object.keys(conns).join(", ")}`)
  }
})

function shutdown(signal: NodeJS.Signals): void {
  logLine(`Received ${signal}, shutting down…`)
  server.close(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
