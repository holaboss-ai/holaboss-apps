/**
 * composio-spike-byo-creds
 *
 * Phase 0 spike for the manifest-driven integration routing plan
 * (`holaOS/docs/plans/2026-04-26-yaml-driven-integration-routing.md`).
 *
 * Goal: BEFORE we lock the manifest schema in Phase 1, validate empirically
 * that Composio's `use_custom_auth: true` flow accepts the field shapes the
 * manifest will declare, for at least two manual_token toolkits (hubspot +
 * calcom). The spike output drives:
 *
 *   - per-toolkit `auth.fields[].name` values in `marketplace.json`
 *   - `auth_config_id` provisioning strategy (D1 — shared byo-creds)
 *   - Phase 3 estimating accuracy (CredentialsModal post-connect verify works
 *     against the same proxy path we'd ship)
 *
 * Usage:
 *   COMPOSIO_API_KEY=xxx pnpm composio:spike-byo-creds <toolkit-slug> [flags]
 *
 *   # Recommended pair:
 *   pnpm composio:spike-byo-creds hubspot --api-key hubspot_xxx
 *   pnpm composio:spike-byo-creds calcom  --api-key calcom_xxx
 *
 *   # Full credential set (when the toolkit needs more than --api-key):
 *   pnpm composio:spike-byo-creds <slug> --credentials-json '{"foo":"bar"}'
 *   pnpm composio:spike-byo-creds <slug> --credentials-json @./creds.json
 *
 *   # Override the auth scheme if inferAuthScheme can't tell:
 *   pnpm composio:spike-byo-creds <slug> --api-key X --auth-scheme BEARER_TOKEN
 *
 * What it does:
 *   1. Provision (or reuse) a shared byo-creds auth_config for <toolkit>.
 *   2. Create a connected_account with use_custom_auth: true + the supplied
 *      credentials.
 *   3. Poll the account until ACTIVE (or surface the failure shape).
 *   4. Hit a known verify endpoint via Composio's proxy (per-toolkit
 *      hard-coded below — these are the same endpoints the eventual
 *      <provider>_get_connection_status MCP tool uses).
 *   5. Print a structured report (JSON + human summary) capturing:
 *        - what fields Composio actually persisted on the auth_config
 *        - whether the verify call returned 2xx
 *        - latency per step
 *        - error response shape on failure (so we can wire useful messages
 *          into CredentialsModal in Phase 3)
 *
 * Output is intended to be pasted back into the design doc / phase tracker.
 *
 * This script is NOT wired into any release flow. It only talks to Composio
 * with the user's COMPOSIO_API_KEY; it doesn't modify .composio-connections.json
 * or touch dev broker state.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  type ComposioAuthScheme,
  createManagedConnectLink,
  getConnectedAccount,
  inferAuthScheme,
  proxyProviderRequest,
  waitForConnectedAccount,
} from "./composio-client"

interface Args {
  toolkitSlug: string
  apiKey?: string
  credentialsJson?: string
  authScheme?: ComposioAuthScheme
  userId: string
  baseUrl?: string
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"))
  const slug = positional[0]
  if (!slug) {
    fail(
      "missing toolkit slug. Usage: pnpm composio:spike-byo-creds <slug> [--api-key X | --credentials-json '...']",
    )
  }

  const flag = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`))
    if (eq) return eq.slice(name.length + 3)
    const idx = argv.indexOf(`--${name}`)
    if (idx === -1) return undefined
    return argv[idx + 1]
  }

  return {
    toolkitSlug: slug,
    apiKey: flag("api-key"),
    credentialsJson: flag("credentials-json"),
    authScheme: flag("auth-scheme") as ComposioAuthScheme | undefined,
    userId: flag("user-id") ?? `holaboss-spike-${process.env.USER ?? "anon"}`,
    baseUrl: flag("base-url"),
  }
}

function loadCredentials(args: Args): Record<string, string> {
  if (args.apiKey && args.credentialsJson) {
    fail("pass either --api-key OR --credentials-json, not both")
  }
  if (args.apiKey) {
    return { api_key: args.apiKey }
  }
  if (!args.credentialsJson) {
    fail(
      "no credentials supplied. Pass --api-key <key> for API-key toolkits or --credentials-json '{...}' for richer shapes.",
    )
  }
  const raw = args.credentialsJson.startsWith("@")
    ? readFileSync(resolve(args.credentialsJson.slice(1)), "utf8")
    : args.credentialsJson
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    fail(`--credentials-json is not valid JSON: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("--credentials-json must decode to an object")
  }
  return parsed as Record<string, string>
}

/**
 * Per-toolkit verify probe. Endpoints chosen to be:
 *   - read-only,
 *   - cheap (no plan-tier paywall),
 *   - return 200 only when the credential is genuinely valid (so a 401/403
 *     here surfaces a real auth failure rather than a routing miss).
 *
 * If the toolkit isn't listed here, the spike still runs; verify is skipped
 * and the report flags it.
 */
const VERIFY_PROBES: Record<
  string,
  { method: "GET" | "POST"; endpoint: string; body?: unknown; note: string }
> = {
  hubspot: {
    method: "GET",
    endpoint: "https://api.hubapi.com/crm/v3/owners?limit=1",
    note: "Lists owners — returns 200 on healthy private app token regardless of which scopes are granted.",
  },
  calcom: {
    method: "GET",
    endpoint: "https://api.cal.com/v2/me",
    note: "Returns the authenticated user — universal /me probe.",
  },
  attio: {
    method: "GET",
    endpoint: "https://api.attio.com/v2/self",
    note: "Returns the API key's identity.",
  },
  apollo: {
    method: "GET",
    endpoint: "https://api.apollo.io/v1/auth/health",
    note: "Apollo's auth health endpoint — works on free + paid plans.",
  },
  instantly: {
    method: "GET",
    endpoint: "https://api.instantly.ai/api/v2/campaigns?limit=1",
    note: "Cheapest listing call available on Instantly v2.",
  },
}

interface StepTiming {
  step: string
  ms: number
  ok: boolean
  detail?: string
}

interface SpikeReport {
  toolkitSlug: string
  authScheme: ComposioAuthScheme | "(inferred)"
  credentialFields: string[]
  authConfigId: string
  connectedAccountId: string
  connectedAccountStatus: string
  verify: {
    skipped?: true
    method?: "GET" | "POST"
    endpoint?: string
    httpStatus?: number
    ok?: boolean
    sampleBody?: string
  }
  diagnostics?: ComposioDiagnostics
  timings: StepTiming[]
  conclusion: "PASS" | "FAIL"
  failureNote?: string
}

interface ComposioDiagnostics {
  authConfig?: Record<string, unknown>
  connectedAccount?: Record<string, unknown>
  toolkit?: Record<string, unknown>
}

async function dumpDiagnostics(
  apiKey: string,
  baseUrl: string | undefined,
  ids: { authConfigId: string; connectedAccountId: string },
): Promise<ComposioDiagnostics> {
  const base = (baseUrl ?? "https://backend.composio.dev").replace(/\/+$/, "")
  const fetchJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const r = await fetch(`${base}${path}`, {
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      })
      const text = await r.text()
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  const [authConfig, connectedAccount, toolkit] = await Promise.all([
    fetchJson(`/api/v3/auth_configs/${ids.authConfigId}`),
    fetchJson(`/api/v3/connected_accounts/${ids.connectedAccountId}`),
    fetchJson(`/api/v3/toolkits/${ids.authConfigId.replace(/^ac_/, "")}`).then(() => undefined),
  ])
  return { authConfig, connectedAccount, toolkit }
}

/** Translate Composio's diagnostic payload into a one-line actionable hint. */
function hintFromDiagnostics(
  toolkitSlug: string,
  status: string,
  diag: ComposioDiagnostics,
  passedScheme: ComposioAuthScheme | undefined,
  passedFields: string[],
): string | undefined {
  // Read the auth_config's expected fields. Composio surfaces this as
  // `expected_input_fields` or `auth_config.fields` depending on api version.
  const ac = diag.authConfig ?? {}
  const expectedFields =
    (ac["expected_input_fields"] as Array<{ name?: string }> | undefined) ??
    (ac["fields"] as Array<{ name?: string }> | undefined) ??
    ((ac["auth_config"] as Record<string, unknown> | undefined)?.["expected_input_fields"] as
      | Array<{ name?: string }>
      | undefined)
  const expectedNames = (expectedFields ?? [])
    .map((f) => f?.name)
    .filter((n): n is string => typeof n === "string")
  const expectedScheme =
    (ac["auth_scheme"] as string | undefined) ??
    ((ac["auth_config"] as Record<string, unknown> | undefined)?.["auth_scheme"] as string | undefined)

  const missing = expectedNames.filter((n) => !passedFields.includes(n))
  const extra = passedFields.filter((n) => expectedNames.length > 0 && !expectedNames.includes(n))

  const parts: string[] = []
  parts.push(`Status stuck at ${status}.`)
  if (expectedScheme && passedScheme && expectedScheme !== passedScheme) {
    parts.push(`Composio expected auth_scheme="${expectedScheme}" but we sent "${passedScheme}". Re-run with --auth-scheme ${expectedScheme}.`)
  }
  if (missing.length || extra.length) {
    parts.push(
      `Field-name mismatch — Composio expected [${expectedNames.join(", ") || "(none reported)"}], we sent [${passedFields.join(", ")}].`,
    )
    if (missing.length) {
      parts.push(`Try: --credentials-json '${JSON.stringify(Object.fromEntries(missing.map((n) => [n, "<value>"])))}'`)
    }
  }
  if (toolkitSlug === "hubspot" && passedScheme === "API_KEY") {
    parts.push(
      `HubSpot Private App tokens are bearer-style. Try: --credentials-json '{"token":"hubspot_xxx"}' --auth-scheme BEARER_TOKEN`,
    )
  }
  return parts.length > 1 ? parts.join(" ") : undefined
}

async function runSpike(args: Args, apiKey: string): Promise<SpikeReport> {
  const credentials = loadCredentials(args)
  const credentialFields = Object.keys(credentials)
  const authScheme = args.authScheme ?? inferAuthScheme(credentials)
  const timings: StepTiming[] = []

  const t0 = Date.now()
  const connect = await createManagedConnectLink({
    apiKey,
    toolkitSlug: args.toolkitSlug,
    userId: args.userId,
    baseUrl: args.baseUrl,
    customCredentials: credentials,
    authScheme: args.authScheme,
  })
  timings.push({
    step: "auth_config + connected_account",
    ms: Date.now() - t0,
    ok: true,
  })

  const t1 = Date.now()
  let account: Awaited<ReturnType<typeof getConnectedAccount>>
  try {
    account = await waitForConnectedAccount({
      apiKey,
      connectedAccountId: connect.connectedAccountId,
      baseUrl: args.baseUrl,
      timeoutMs: 60_000,
      intervalMs: 2_000,
    })
  } catch (err) {
    const fallback = await getConnectedAccount({
      apiKey,
      connectedAccountId: connect.connectedAccountId,
      baseUrl: args.baseUrl,
    })
    const diag = await dumpDiagnostics(apiKey, args.baseUrl, {
      authConfigId: connect.authConfigId,
      connectedAccountId: connect.connectedAccountId,
    })
    timings.push({
      step: "wait for ACTIVE",
      ms: Date.now() - t1,
      ok: false,
      detail: (err as Error).message,
    })
    return {
      toolkitSlug: args.toolkitSlug,
      authScheme: authScheme ?? "(inferred)",
      credentialFields,
      authConfigId: fallback.authConfigId ?? connect.authConfigId,
      connectedAccountId: connect.connectedAccountId,
      connectedAccountStatus: fallback.status,
      verify: { skipped: true },
      diagnostics: diag,
      timings,
      conclusion: "FAIL",
      failureNote: hintFromDiagnostics(args.toolkitSlug, fallback.status, diag, args.authScheme, credentialFields)
        ?? `Connected account never became ACTIVE: ${(err as Error).message}`,
    }
  }
  timings.push({
    step: "wait for ACTIVE",
    ms: Date.now() - t1,
    ok: true,
  })

  const probe = VERIFY_PROBES[args.toolkitSlug]
  if (!probe) {
    return {
      toolkitSlug: args.toolkitSlug,
      authScheme: authScheme ?? "(inferred)",
      credentialFields,
      authConfigId: account.authConfigId ?? "(unknown)",
      connectedAccountId: account.id,
      connectedAccountStatus: account.status,
      verify: { skipped: true },
      timings,
      conclusion: "PASS",
      failureNote:
        "No verify probe registered for this toolkit; account became ACTIVE but the credentials were not exercised. " +
        "Add an entry to VERIFY_PROBES if you want signal.",
    }
  }

  const t2 = Date.now()
  let verifyResult: Awaited<ReturnType<typeof proxyProviderRequest>>
  try {
    verifyResult = await proxyProviderRequest({
      apiKey,
      connectedAccountId: account.id,
      method: probe.method,
      endpoint: probe.endpoint,
      body: probe.body,
      baseUrl: args.baseUrl,
    })
    timings.push({
      step: "verify probe",
      ms: Date.now() - t2,
      ok: verifyResult.status >= 200 && verifyResult.status < 300,
      detail: `${probe.method} ${probe.endpoint} → ${verifyResult.status}`,
    })
  } catch (err) {
    timings.push({
      step: "verify probe",
      ms: Date.now() - t2,
      ok: false,
      detail: (err as Error).message,
    })
    return {
      toolkitSlug: args.toolkitSlug,
      authScheme: authScheme ?? "(inferred)",
      credentialFields,
      authConfigId: account.authConfigId ?? "(unknown)",
      connectedAccountId: account.id,
      connectedAccountStatus: account.status,
      verify: { method: probe.method, endpoint: probe.endpoint },
      timings,
      conclusion: "FAIL",
      failureNote: `Verify call threw: ${(err as Error).message}`,
    }
  }

  const verifyOk = verifyResult.status >= 200 && verifyResult.status < 300
  return {
    toolkitSlug: args.toolkitSlug,
    authScheme: authScheme ?? "(inferred)",
    credentialFields,
    authConfigId: account.authConfigId ?? "(unknown)",
    connectedAccountId: account.id,
    connectedAccountStatus: account.status,
    verify: {
      method: probe.method,
      endpoint: probe.endpoint,
      httpStatus: verifyResult.status,
      ok: verifyOk,
      sampleBody: previewBody(verifyResult.data),
    },
    timings,
    conclusion: verifyOk ? "PASS" : "FAIL",
    failureNote: verifyOk
      ? undefined
      : `Account ACTIVE but verify call returned HTTP ${verifyResult.status}. Likely scope or token-shape mismatch.`,
  }
}

function previewBody(data: unknown): string {
  if (data == null) return "(empty)"
  const str = typeof data === "string" ? data : JSON.stringify(data)
  return str.length > 200 ? `${str.slice(0, 197)}…` : str
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces)
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n")
}

function printReport(report: SpikeReport) {
  const status = report.conclusion === "PASS" ? "✅ PASS" : "❌ FAIL"
  console.log("")
  console.log("─".repeat(72))
  console.log(`Composio byo-creds spike — ${report.toolkitSlug}    ${status}`)
  console.log("─".repeat(72))
  console.log(`  Manifest implication for hola-boss-apps/marketplace.json:`)
  console.log(`    auth:`)
  console.log(`      mode: "manual_token"`)
  console.log(`      fields:`)
  for (const name of report.credentialFields) {
    console.log(`        - { name: "${name}", type: "secret", required: true }`)
  }
  console.log("")
  console.log(`  Inferred auth_scheme: ${report.authScheme}`)
  console.log(`  auth_config_id:       ${report.authConfigId}`)
  console.log(`  connected_account_id: ${report.connectedAccountId} (${report.connectedAccountStatus})`)
  console.log("")
  console.log("  Timings:")
  for (const t of report.timings) {
    const mark = t.ok ? "  ✓" : "  ✗"
    const detail = t.detail ? ` — ${t.detail}` : ""
    console.log(`    ${mark} ${t.step.padEnd(32)} ${String(t.ms).padStart(5)}ms${detail}`)
  }
  console.log("")
  if (report.verify.skipped) {
    console.log(`  Verify: skipped (${report.failureNote ?? "no probe registered"})`)
  } else {
    const v = report.verify
    const mark = v.ok ? "✓" : "✗"
    console.log(`  Verify ${mark}  ${v.method} ${v.endpoint}`)
    console.log(`         HTTP ${v.httpStatus}`)
    console.log(`         body: ${v.sampleBody ?? "(empty)"}`)
  }
  if (report.failureNote && report.conclusion === "FAIL") {
    console.log("")
    console.log(`  Failure note: ${report.failureNote}`)
  }
  if (report.diagnostics?.authConfig || report.diagnostics?.connectedAccount) {
    console.log("")
    console.log("  Composio diagnostics (post-failure dump):")
    if (report.diagnostics.authConfig) {
      console.log("    auth_config:")
      console.log(indent(JSON.stringify(report.diagnostics.authConfig, null, 2), 6))
    }
    if (report.diagnostics.connectedAccount) {
      console.log("    connected_account:")
      console.log(indent(JSON.stringify(report.diagnostics.connectedAccount, null, 2), 6))
    }
  }
  console.log("─".repeat(72))
  console.log("")

  // Also dump the full report as JSON so it can be piped / saved.
  console.log("Full report (JSON):")
  console.log(JSON.stringify(report, null, 2))
}

function fail(msg: string): never {
  console.error(`composio:spike-byo-creds: ${msg}`)
  process.exit(1)
}

async function main() {
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) {
    fail("COMPOSIO_API_KEY env var is required.")
  }
  const args = parseArgs(process.argv.slice(2))

  try {
    const report = await runSpike(args, apiKey)
    printReport(report)
    process.exit(report.conclusion === "PASS" ? 0 : 2)
  } catch (err) {
    console.error("")
    console.error("Spike crashed before producing a report:")
    console.error((err as Error).stack ?? (err as Error).message)
    process.exit(3)
  }
}

void main()
