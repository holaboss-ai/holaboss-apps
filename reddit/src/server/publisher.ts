import { createIntegrationClient } from "./holaboss-bridge"

const REDDIT_API = "https://oauth.reddit.com"
const reddit = createIntegrationClient("reddit")

export interface PublishInput {
  holaboss_user_id: string
  title: string
  content: string
  subreddit: string
  scheduled_at?: string
}

export interface PublishOutput {
  external_post_id: string
}

export class RedditPublisher {
  async publish(input: PublishInput): Promise<PublishOutput> {
    const result = await reddit.proxy<{
      data: {
        json?: { data?: { id?: string; name?: string; url?: string } }
        id?: string
        name?: string
      }
    }>({
      method: "POST",
      endpoint: `${REDDIT_API}/api/submit`,
      body: {
        sr: input.subreddit,
        kind: "self",
        title: input.title,
        text: input.content,
        resubmit: true,
      },
    })

    if (result.status >= 400) {
      throw new Error(
        `publish_failed:reddit_api:${result.status}:${JSON.stringify(result.data).slice(0, 500)}`,
      )
    }

    const postId =
      result.data?.data?.json?.data?.name ??
      result.data?.data?.json?.data?.id ??
      result.data?.data?.name ??
      result.data?.data?.id
    if (!postId) {
      throw new Error(
        `publish_failed:missing_post_id:${JSON.stringify(result.data).slice(0, 500)}`,
      )
    }

    return { external_post_id: postId }
  }
}
