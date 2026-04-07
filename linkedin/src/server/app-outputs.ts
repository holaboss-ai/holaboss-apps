import type { PostRecord } from "../lib/types"
import {
  buildAppResourcePresentation,
  publishSessionArtifact,
  updateAppOutput,
  type HolabossTurnContext,
} from "./holaboss-bridge"

export function postRoutePath(postId: string): string {
  return `/posts/${encodeURIComponent(postId)}`
}

export function buildPostOutputTitle(post: PostRecord): string {
  const content = post.content.trim()
  if (!content) {
    return `LinkedIn draft ${post.id}`
  }
  return content.length > 80 ? `${content.slice(0, 77)}...` : content
}

export function buildPostOutputMetadata(post: PostRecord): Record<string, unknown> {
  return {
    source_kind: "application",
    presentation: buildAppResourcePresentation({
      view: "posts",
      path: postRoutePath(post.id),
    }),
    resource: {
      entity_type: "post",
      entity_id: post.id,
      label: buildPostOutputTitle(post),
    },
  }
}

export async function syncPostDraftArtifact(
  post: PostRecord,
  context: HolabossTurnContext,
): Promise<string | null> {
  const title = buildPostOutputTitle(post)
  const metadata = buildPostOutputMetadata(post)

  if (post.output_id) {
    await updateAppOutput(post.output_id, {
      title,
      status: post.status,
      moduleResourceId: post.id,
      metadata,
    })
    return post.output_id
  }

  const artifact = await publishSessionArtifact(context, {
    artifactType: "draft",
    externalId: post.id,
    title,
    moduleId: "linkedin",
    moduleResourceId: post.id,
    platform: "linkedin",
    metadata,
  })

  return artifact?.output_id ?? null
}
