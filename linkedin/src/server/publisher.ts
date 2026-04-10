import { createIntegrationClient } from "./holaboss-bridge"

const LINKEDIN_API = "https://api.linkedin.com/v2"
const linkedin = createIntegrationClient("linkedin")

export interface PublishInput {
  holaboss_user_id: string
  content: string
  scheduled_at?: string
}

export interface PublishOutput {
  external_post_id: string
}

export class LinkedInPublisher {
  private async resolveAuthorUrn(): Promise<string> {
    const result = await linkedin.proxy<{
      sub?: string
    }>({
      method: "GET",
      endpoint: `${LINKEDIN_API}/userinfo`,
    })
    const sub = result.data?.sub
    if (!sub) {
      throw new Error(
        `publish_failed:linkedin_profile:${result.status}:${JSON.stringify(result.data).slice(0, 500)}`,
      )
    }
    return `urn:li:person:${sub}`
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    const authorUrn = await this.resolveAuthorUrn()

    const result = await linkedin.proxy<{
      data: { id?: string }
    }>({
      method: "POST",
      endpoint: `${LINKEDIN_API}/ugcPosts`,
      body: {
        author: authorUrn,
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: input.content },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
        },
        lifecycleState: "PUBLISHED",
      },
    })

    if (result.status >= 400) {
      throw new Error(
        `publish_failed:linkedin_api:${result.status}:${JSON.stringify(result.data).slice(0, 500)}`,
      )
    }

    const postId = result.data?.data?.id
    if (!postId) {
      throw new Error(
        `publish_failed:missing_post_id:${JSON.stringify(result.data).slice(0, 500)}`,
      )
    }

    return { external_post_id: postId }
  }
}
