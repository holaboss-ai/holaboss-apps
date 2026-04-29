import { createServerFn } from "@tanstack/react-start"
import type { DraftRecord } from "../lib/types"
import { getDb } from "./db"
import { getThread, parseMessage, type ParsedMessage } from "./google-api"

export const fetchDrafts = createServerFn({ method: "GET" }).handler(async () => {
  const db = getDb()
  return db.prepare("SELECT * FROM gmail_drafts ORDER BY created_at DESC LIMIT 50").all() as DraftRecord[]
})

export const fetchDraftById = createServerFn({ method: "GET" })
  .inputValidator((data: { draftId: string }) => data)
  .handler(async ({ data }) => {
    const db = getDb()
    const draft = db.prepare("SELECT * FROM gmail_drafts WHERE id = ? LIMIT 1").get(data.draftId) as DraftRecord | undefined
    return draft ?? null
  })

export interface ThreadDetailRecord {
  id: string
  subject: string
  primaryEmail: string
  messages: ParsedMessage[]
}

function firstNonEmpty(values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = (value ?? "").trim()
    if (normalized) {
      return normalized
    }
  }
  return ""
}

function extractEmailAddress(value: string): string {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match?.[0] ?? ""
}

export const fetchThreadById = createServerFn({ method: "GET" })
  .inputValidator((data: { threadId: string }) => data)
  .handler(async ({ data }): Promise<ThreadDetailRecord> => {
    const thread = await getThread(data.threadId)
    const messages = thread.messages.map(parseMessage)
    const primaryEmail = firstNonEmpty(
      messages.flatMap((message) => [
        extractEmailAddress(message.to),
        extractEmailAddress(message.from),
      ]),
    )

    return {
      id: thread.id,
      subject: firstNonEmpty(messages.map((message) => message.subject)),
      primaryEmail,
      messages,
    }
  })
