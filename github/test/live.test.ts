/**
 * Live tests against real Composio. See ../docs/LIVE_TESTING.md.
 * Run: pnpm test:live (after pnpm composio:broker + pnpm composio:connect github).
 *
 * Read-only — github module has no write tools, so LIVE_WRITE has no effect.
 */
import { describe, expect, it } from "vitest"

import { listUserRepos } from "../src/server/github-api"

const live = !!process.env.LIVE

describe.skipIf(!live)("github live (real Composio)", () => {
  it("listUserRepos returns an array of repos for the authed user", async () => {
    const repos = await listUserRepos(undefined, 3)
    expect(Array.isArray(repos)).toBe(true)
    if (repos.length > 0) {
      const first = repos[0] as Record<string, unknown>
      expect(typeof first.name === "string" || typeof first.full_name === "string").toBe(true)
    }
  }, 30_000)
})
