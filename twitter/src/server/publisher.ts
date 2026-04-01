import { createIntegrationClient } from "./holaboss-bridge"

const TWITTER_API = "https://api.twitter.com/2"
const twitter = createIntegrationClient("twitter")

export interface PublishInput {
  holaboss_user_id: string
  content: string
  scheduled_at?: string
}

export interface PublishOutput {
  external_post_id: string
}

export class TwitterPublisher {
  async publish(input: PublishInput): Promise<PublishOutput> {
    const result = await twitter.proxy<{ data: { id: string; text: string } }>({
      method: "POST",
      endpoint: `${TWITTER_API}/tweets`,
      body: { text: input.content },
    })

    if (result.status >= 400) {
      throw new Error(
        `publish_failed:twitter_api:${result.status}:${JSON.stringify(result.data).slice(0, 500)}`,
      )
    }

    const tweetId = result.data?.data?.id
    if (!tweetId) {
      throw new Error(`publish_failed:missing_tweet_id:${JSON.stringify(result.data).slice(0, 500)}`)
    }

    return { external_post_id: tweetId }
  }
}
