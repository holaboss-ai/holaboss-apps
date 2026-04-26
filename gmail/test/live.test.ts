/**
 * Live tests against real Composio. See ../docs/LIVE_TESTING.md.
 * Run: pnpm test:live (after pnpm composio:broker + pnpm composio:connect gmail).
 *
 * Read-only by default. LIVE_WRITE=1 would exercise gmail_send_draft;
 * intentionally NOT wired here — sending real email from a test is too
 * easy to misuse. If you need to test send, do it manually via the MCP
 * tool surface against a known throwaway recipient.
 */
import { describe, expect, it } from "vitest"

import { listThreads } from "../src/server/google-api"

const live = !!process.env.LIVE

describe.skipIf(!live)("gmail live (real Composio)", () => {
  it("listThreads returns an array (may be empty for a new account)", async () => {
    const threads = await listThreads("from:me", 5)
    expect(Array.isArray(threads)).toBe(true)
    if (threads.length > 0) {
      expect(typeof threads[0].id).toBe("string")
      expect(typeof threads[0].snippet).toBe("string")
    }
  }, 30_000)
})
