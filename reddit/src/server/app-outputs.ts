import type Database from "better-sqlite3"

import type { PostRecord } from "../lib/types"
import {
  syncAppResourceOutput,
  type HolabossTurnContext,
} from "./holaboss-bridge"

export function postRoutePath(postId: string): string {
  return `/posts/${encodeURIComponent(postId)}`
}

export function buildPostOutputTitle(post: PostRecord): string {
  const title = post.title.trim()
  if (title) {
    return title
  }
  return `Reddit draft ${post.id}`
}

export async function syncPostDraftArtifact(
  post: PostRecord,
  context: HolabossTurnContext | null,
): Promise<string | null> {
  const { outputId } = await syncAppResourceOutput(context, {
    moduleId: "reddit",
    platform: "reddit",
    artifactType: "draft",
    existingOutputId: post.output_id ?? null,
    status: post.status,
    resource: {
      entityType: "post",
      entityId: post.id,
      title: buildPostOutputTitle(post),
      view: "posts",
      path: postRoutePath(post.id),
    },
    extraMetadata: {
      reddit: { subreddit: post.subreddit },
    },
  })
  return outputId
}

export async function syncPostOutputAndPersist(
  db: Database.Database,
  post: PostRecord,
  context: HolabossTurnContext | null,
): Promise<PostRecord> {
  try {
    const outputId = await syncPostDraftArtifact(post, context)
    if (outputId && outputId !== post.output_id) {
      db.prepare("UPDATE reddit_posts SET output_id = ? WHERE id = ?").run(
        outputId,
        post.id,
      )
      return db
        .prepare("SELECT * FROM reddit_posts WHERE id = ?")
        .get(post.id) as PostRecord
    }
  } catch (syncError) {
    console.error(
      `[reddit] output sync failed for post ${post.id}:`,
      syncError,
    )
  }
  return post
}
