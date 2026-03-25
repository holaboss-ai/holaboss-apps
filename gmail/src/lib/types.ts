export interface DraftRecord {
  id: string
  to_email: string
  gmail_thread_id: string | null
  subject: string | null
  body: string
  status: "pending" | "sent" | "discarded"
  sent_at: string | null
  created_at: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
}

export const MODULE_CONFIG: PlatformConfig = {
  provider: "google",
  destination: "google",
  name: "Gmail",
}
