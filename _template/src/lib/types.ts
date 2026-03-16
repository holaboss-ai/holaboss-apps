export interface PostRecord {
  id: string
  content: string
  status: "draft" | "queued" | "scheduled" | "published" | "failed"
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

// TODO: Replace with your module's config
export const MODULE_CONFIG: PlatformConfig = {
  provider: "your-nango-provider-id",
  destination: "your-module",
  name: "Your Module",
}
