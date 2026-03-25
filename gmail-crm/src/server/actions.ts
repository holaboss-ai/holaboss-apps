import { createServerFn } from "@tanstack/react-start"
import type { ContactRecord, DraftRecord, InteractionRecord } from "../lib/types"
import { getDb } from "./db"

export const fetchContacts = createServerFn({ method: "GET" }).handler(
  async () => {
    const db = getDb()
    return db
      .prepare(
        "SELECT * FROM contacts ORDER BY last_contact_at DESC NULLS LAST, updated_at DESC LIMIT 100"
      )
      .all() as ContactRecord[]
  }
)

export const fetchContact = createServerFn({ method: "GET" })
  .validator((input: string) => input)
  .handler(async ({ data: contactId }) => {
    const db = getDb()
    const contact = db
      .prepare("SELECT * FROM contacts WHERE id = ?")
      .get(contactId) as ContactRecord | undefined
    if (!contact) throw new Error("Contact not found")

    const interactions = db
      .prepare(
        "SELECT * FROM interactions WHERE contact_id = ? ORDER BY timestamp DESC LIMIT 20"
      )
      .all(contactId) as InteractionRecord[]

    const drafts = db
      .prepare(
        "SELECT * FROM drafts WHERE contact_id = ? AND status = 'pending' ORDER BY created_at DESC"
      )
      .all(contactId) as DraftRecord[]

    return { contact, interactions, drafts }
  })

export const fetchDrafts = createServerFn({ method: "GET" }).handler(
  async () => {
    const db = getDb()
    return db
      .prepare(
        `SELECT d.*, c.email, c.name
       FROM drafts d
       JOIN contacts c ON c.id = d.contact_id
       WHERE d.status = 'pending'
       ORDER BY d.created_at DESC`
      )
      .all() as Array<DraftRecord & { email: string; name: string | null }>
  }
)
