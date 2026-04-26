/**
 * Live tests against real Composio. See ../docs/LIVE_TESTING.md.
 * Run: pnpm test:live (after pnpm composio:broker + pnpm composio:connect googlesheets).
 *
 * Read-only by default. Cell/row writes need a SHEETS_TEST_SHEET_ID env var
 * pointing at a throwaway sheet (we never want to clobber a real workspace).
 */
import { describe, expect, it } from "vitest"

import { listSpreadsheets, getSheetInfo } from "../src/server/google-api"

const live = !!process.env.LIVE
const writeable = process.env.LIVE_WRITE && process.env.SHEETS_TEST_SHEET_ID

describe.skipIf(!live)("sheets live (real Composio)", () => {
  it("listSpreadsheets returns an array (may be empty for a new account)", async () => {
    const sheets = await listSpreadsheets()
    expect(Array.isArray(sheets)).toBe(true)
  }, 30_000)

  it("getSheetInfo on a known throwaway sheet returns headers + rowCount", async () => {
    if (!process.env.SHEETS_TEST_SHEET_ID) return // Test is informational without a target.
    const info = await getSheetInfo(process.env.SHEETS_TEST_SHEET_ID)
    expect(typeof info.title).toBe("string")
    expect(Array.isArray(info.headers)).toBe(true)
    expect(typeof info.rowCount).toBe("number")
  }, 30_000)

  describe.skipIf(!writeable)("write (LIVE_WRITE=1 + SHEETS_TEST_SHEET_ID)", () => {
    // Intentionally empty — wire targeted append/update tests here when you
    // have a designated throwaway sheet. Don't add CRUD tests against arbitrary
    // sheets; data loss risk is real.
    it("placeholder", () => {
      expect(true).toBe(true)
    })
  })
})
