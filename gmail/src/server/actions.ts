import { createServerFn } from "@tanstack/react-start"
import type { DraftRecord } from "../lib/types"
import { getDb } from "./db"

export const fetchDrafts = createServerFn({ method: "GET" }).handler(async () => {
  const db = getDb()
  return db.prepare("SELECT * FROM drafts ORDER BY created_at DESC LIMIT 50").all() as DraftRecord[]
})
