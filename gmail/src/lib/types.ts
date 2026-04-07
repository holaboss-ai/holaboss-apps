export interface DraftRecord {
  id: string
  to_email: string
  gmail_thread_id: string | null
  subject: string | null
  body: string
  status: "pending" | "queued" | "sent" | "failed" | "discarded"
  output_id: string | null
  error_message: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

export interface SendJobPayload {
  draft_id: string
  to_email: string
  subject: string
  body: string
  thread_id?: string
  holaboss_user_id: string
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
