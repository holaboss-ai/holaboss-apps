# Live testing — modules against real Composio without desktop

A 5-step path from "fresh checkout" to "first green live test", running the
full module stack against the real Composio backend WITHOUT booting the
Holaboss desktop app or the in-sandbox runtime.

## What this gives you

- Each module gets a `pnpm test:live` that hits real Composio through real
  OAuth tokens for one or more provider(s) you've connected once and forgot.
- Read-only by default. Writes are gated behind `LIVE_WRITE=1` (and per-module
  conditions like `SHEETS_TEST_SHEET_ID`) so a casual run can't post a tweet,
  send an email, or mutate an Attio record.
- Zero new processes for unit/integration tests — they use a `MockBridge`
  fixture and run completely offline like before.

## Prereqs

- A Composio API key. Get one from the Composio dashboard. Treat it like any
  other secret — keep it out of shell history (`set +o history` or use a
  `.env.local` your shell sources but git ignores).
- pnpm installed at the repo root.

## Setup (one-time per machine)

```bash
cd hola-boss-apps/
pnpm install              # installs tsx for the broker scripts

# Terminal 1 — start the dev broker (port 3099). Leave it running.
COMPOSIO_API_KEY=cmp_xxx pnpm composio:broker

# Terminal 2 — connect each provider you want to test, ONCE.
# The CLI prints an OAuth URL, you open it, finish the dance, and the
# connectedAccountId is persisted to .composio-connections.json (gitignored).
COMPOSIO_API_KEY=cmp_xxx pnpm composio:connect gmail
COMPOSIO_API_KEY=cmp_xxx pnpm composio:connect github
COMPOSIO_API_KEY=cmp_xxx pnpm composio:connect hubspot
# … etc.
```

Composio toolkit slugs (the argument to `composio:connect`) are usually the
lowercase brand name: `gmail`, `github`, `googlesheets`, `hubspot`, `apollo`,
`zoominfo`, `instantly`, `calcom`, `attio`, `linkedin`, `twitter`, `reddit`.
If the slug differs, Composio will tell you in the API error.

Visit `http://localhost:3099/` in a browser to see which providers the broker
currently has connections for.

## Run

```bash
# In the module directory:
cd apollo/
pnpm test:live

# … or from repo root:
pnpm --filter apollo run test:live
```

That sets `HOLABOSS_INTEGRATION_BROKER_URL=http://localhost:3099` +
`HOLABOSS_APP_GRANT=grant:dev:0:0` and runs `vitest test/live.test.ts`.

Test files default to `describe.skipIf(!process.env.LIVE)` so they're noop in
the regular `pnpm test` run.

## Writes (`LIVE_WRITE=1`)

Each module's `test/live.test.ts` keeps write tools behind a separate gate.
Apollo / Instantly / HubSpot / Attio / ZoomInfo expose a `LIVE_WRITE`-gated
block:

```bash
LIVE_WRITE=1 pnpm test:live
```

**Read this before you set it.** Write tools mutate real third-party state:
- `apollo_enrich_person` consumes Apollo credits.
- `instantly_pause_campaign` / `_resume_campaign` affect real running campaigns.
- `hubspot_create_contact` creates a real contact in your HubSpot portal.
- `zoominfo_enrich_*` consumes credits.
- `attio_create_*` mutates the workspace.

For sheets, we additionally require `SHEETS_TEST_SHEET_ID` pointing at a
designated throwaway sheet — write tests refuse to touch arbitrary IDs.

For gmail and calcom, write tools (send / cancel / reschedule) are
**intentionally NOT wired** into `LIVE_WRITE`. Sending email and emailing
attendees from a test runner is too easy to misuse. Test those manually if
needed.

## How it works

1. `scripts/composio-dev-broker.ts` listens on `:3099`. It implements
   `POST /broker/proxy`, the exact endpoint the `@holaboss/bridge` SDK calls.
2. Module tools call `createIntegrationClient("apollo").proxy({ ... })`. The
   SDK sends `{ grant, provider: "apollo", request }` to the broker.
3. The broker reads `provider` from the body, looks up
   `connected_account_id` from `.composio-connections.json` (keyed by
   provider — same string you passed to `composio:connect`), and forwards to
   Composio's `/api/v3/tools/execute/proxy`.
4. The broker returns Composio's `{ data, status, headers }` shape verbatim
   to the SDK, which maps it through the module's status-code handler to
   `Result<T, *Error>` with the canonical structured error envelope.

The dev broker SKIPS grant signature validation. Production uses
`integration-broker.ts` from `holaOS/runtime/api-server/`, which validates the
signed grant against the workspace state store. Don't run the dev broker in a
shared environment.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `not_connected` from every tool | Broker isn't running, or `HOLABOSS_INTEGRATION_BROKER_URL` doesn't point at it. | Confirm `curl http://localhost:3099/healthz` returns `{"status":"ok",…}`. |
| `not_connected` from one tool only | No connection for that provider in `.composio-connections.json`. | `pnpm composio:connect <provider>`. |
| `Composio 401: …` in the broker log | Your `COMPOSIO_API_KEY` is wrong or revoked. | Re-issue from Composio dashboard, restart broker. |
| `upstream_error` after a test that previously passed | Composio rate limit, or the third-party API changed. | Wait or check the third-party status page. |
| Live test passes locally but `pnpm test` fails | A live test was written without the `describe.skipIf(!live)` guard. | Add the guard at the top-level `describe` block. |

## Adding a live test to a new module

1. Module client must export `resetBridgeClient()` (Shape B already does).
2. Add `test/live.test.ts` modeled after `apollo/test/live.test.ts`. Top-level
   describe: `describe.skipIf(!process.env.LIVE)("<module> live (real Composio)", …)`.
3. Add the `test:live` script to the module's `package.json`:
   ```json
   "test:live": "LIVE=1 HOLABOSS_INTEGRATION_BROKER_URL=http://localhost:3099 HOLABOSS_APP_GRANT=grant:dev:0:0 vitest run test/live.test.ts"
   ```
4. Test exclusively against tool shape (`Array.isArray`, field types) — never
   against specific data values, since real APIs return whatever the user's
   account has.
5. Gate writes behind `LIVE_WRITE` and document the side effects in the file
   header.
