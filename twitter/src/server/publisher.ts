import { TWITTER_CONFIG } from "../lib/types"

export interface PublishInput {
  holaboss_user_id: string
  content: string
  scheduled_at?: string
}

export interface PublishOutput {
  external_post_id: string
}

export class TwitterPublisher {
  private readonly workspaceApiUrl: string
  private readonly integrationId: string
  private readonly integrationToken: string

  constructor() {
    const raw = process.env.WORKSPACE_API_URL ?? "http://localhost:3033"
    this.workspaceApiUrl = raw.replace(/\/+$/, "")
    this.integrationId = process.env.WORKSPACE_X_INTEGRATION_ID ?? ""
    this.integrationToken = process.env.PLATFORM_INTEGRATION_TOKEN ?? ""
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    if (!this.integrationId) {
      throw new Error("publish_failed:missing_integration_id")
    }

    // Create draft via workspace API
    const draftRes = await fetch(
      `${this.workspaceApiUrl}/api/posts/drafts?userId=${encodeURIComponent(input.holaboss_user_id)}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          provider: TWITTER_CONFIG.provider,
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

    // If scheduled, set schedule and return
    if (input.scheduled_at) {
      const scheduleRes = await fetch(
        `${this.workspaceApiUrl}/api/posts/drafts/${draftId}?userId=${encodeURIComponent(input.holaboss_user_id)}`,
        {
          method: "PUT",
          headers: this.headers(),
          body: JSON.stringify({ scheduledDate: input.scheduled_at }),
        },
      )
      if (!scheduleRes.ok) {
        const body = await scheduleRes.text()
        throw new Error(`publish_failed:schedule:${scheduleRes.status}:${body}`)
      }
      return { external_post_id: draftId }
    }

    // Immediate publish
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

  async cancelScheduled(
    draftId: string,
    userId: string,
    workspaceId?: string,
  ): Promise<boolean> {
    const url = new URL(
      `${this.workspaceApiUrl}/api/posts/drafts/${draftId}`,
    )
    url.searchParams.set("userId", userId)
    if (workspaceId) url.searchParams.set("workspaceId", workspaceId)

    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: this.headers(),
    })
    return res.ok || res.status === 404
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      ...(this.integrationToken
        ? { Authorization: `Bearer ${this.integrationToken}` }
        : {}),
    }
  }
}
