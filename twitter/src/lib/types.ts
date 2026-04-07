export interface PostRecord {
  id: string
  content: string
  status: "draft" | "queued" | "scheduled" | "published" | "failed"
  output_id?: string | null
  external_post_id?: string
  scheduled_at?: string
  published_at?: string
  error_message?: string
  created_at: string
  updated_at: string
}

export interface PublishJobPayload {
  post_id: string
  content: string
  holaboss_user_id: string
  workspace_id?: string
  scheduled_at?: string
}

export interface PlatformConfig {
  provider: string
  destination: string
  name: string
}

export const TWITTER_CONFIG: PlatformConfig = {
  provider: "twitter-xdnq",
  destination: "twitter",
  name: "Twitter/X",
}
