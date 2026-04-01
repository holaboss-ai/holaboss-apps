import { createServerFn } from "@tanstack/react-start"
import type { DraftRecord } from "../lib/types"
import { getDb } from "./db"

export const fetchDrafts = createServerFn({ method: "GET" }).handler(async () => {
  const db = getDb()
  return db.prepare("SELECT * FROM drafts ORDER BY created_at DESC LIMIT 50").all() as DraftRecord[]
})

export const fetchDraftById = createServerFn({ method: "GET" })
  .inputValidator((data: { draftId: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    const draft = db.prepare("SELECT * FROM drafts WHERE id = ? LIMIT 1").get(data.draftId) as DraftRecord | undefined
    return draft ?? null
  })
