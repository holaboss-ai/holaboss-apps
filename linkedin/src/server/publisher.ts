import { createIntegrationClient } from "./holaboss-bridge"

const LINKEDIN_API = "https://api.linkedin.com/rest"
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
  async publish(input: PublishInput): Promise<PublishOutput> {
    const result = await linkedin.proxy<{
      data: { id?: string; value?: { "com.linkedin.ugc.ShareContent"?: { shareCommentary?: { text?: string } } } }
    }>({
      method: "POST",
      endpoint: `${LINKEDIN_API}/posts`,
      body: {
        commentary: input.content,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
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
