export interface ContactRecord {
  id: string
  email: string
  name: string | null
  company: string | null
  stage: string
  notes: string | null
  tags: string | null
  sheet_row_number: number | null
  last_contact_at: string | null
  created_at: string
  updated_at: string
}

export interface InteractionRecord {
  id: string
  contact_id: string
  gmail_thread_id: string | null
  gmail_message_id: string | null
  subject: string | null
  snippet: string | null
  direction: "inbound" | "outbound"
  timestamp: string
  created_at: string
}

export interface DraftRecord {
  id: string
  contact_id: string
  gmail_thread_id: string | null
  subject: string | null
  body: string
  status: "pending" | "sent" | "discarded"
  sent_at: string | null
  created_at: string
}

export const STAGES = [
  "lead",
  "contacted",
  "interested",
  "negotiating",
  "closed-won",
  "closed-lost",
] as const

export type Stage = (typeof STAGES)[number]

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
}

export const MODULE_CONFIG: PlatformConfig = {
  provider: "google",
  destination: "google",
  name: "Gmail CRM",
}
