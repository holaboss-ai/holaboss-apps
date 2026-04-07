import { MODULE_CONFIG } from "../lib/types"

export interface PublishInput {
  holaboss_user_id: string
  content: string
  scheduled_at?: string
}

export interface PublishOutput {
  external_post_id: string
}

// TODO: Rename this class and implement platform-specific publish logic
export class ModulePublisher {
  private readonly workspaceApiUrl: string
  private readonly integrationId: string

  constructor() {
    const raw = process.env.WORKSPACE_API_URL ?? "http://localhost:3033"
    this.workspaceApiUrl = raw.replace(/\/+$/, "")
    this.integrationId = process.env.INTEGRATION_ID ?? ""
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    if (!this.integrationId) {
      throw new Error("publish_failed:missing_integration_id")
    }

    // TODO: Implement platform-specific publish logic
    // This is a template — replace with actual API calls for your platform
    const draftRes = await fetch(
      `${this.workspaceApiUrl}/api/posts/drafts?userId=${encodeURIComponent(input.holaboss_user_id)}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          provider: MODULE_CONFIG.provider,
          integrationId: this.integrationId,
          content: input.content,
          directSend: false,
        }),
      },
    )

    if (!draftRes.ok) {
      const body = await draftRes.text()
      throw new Error(`publish_failed:create_draft:${draftRes.status}:${body}`)
    }

    const draft = (await draftRes.json()) as { postId?: string; id?: string }
    const draftId = draft.postId ?? draft.id
    if (!draftId) throw new Error("publish_failed:missing_draft_id")

    if (input.scheduled_at) {
      await fetch(
        `${this.workspaceApiUrl}/api/posts/drafts/${draftId}?userId=${encodeURIComponent(input.holaboss_user_id)}`,
        {
          method: "PUT",
          headers: this.headers(),
          body: JSON.stringify({ scheduledDate: input.scheduled_at }),
        },
      )
      return { external_post_id: draftId }
    }

    const publishRes = await fetch(
      `${this.workspaceApiUrl}/api/posts/drafts/${draftId}/publish`,
      {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({ userId: input.holaboss_user_id }),
      },
    )

    if (!publishRes.ok) {
      const body = await publishRes.text()
      throw new Error(`publish_failed:publish:${publishRes.status}:${body}`)
    }

    const result = (await publishRes.json()) as Record<string, unknown>
    const externalId =
      (result.external_post_id as string) ??
      (result.externalPostId as string) ??
      (result.postId as string) ??
      (result.id as string) ??
      draftId

    return { external_post_id: externalId }
  }

  private headers() {
    return {
      "Content-Type": "application/json",
    }
  }
}
