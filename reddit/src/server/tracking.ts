import { randomUUID } from "node:crypto"

import type Database from "better-sqlite3"

import { getDb } from "./db"
import { createIntegrationClient } from "./holaboss-bridge"

const REDDIT_API = "https://oauth.reddit.com"
const reddit = createIntegrationClient("reddit")

export interface TrackPostInput {
  url: string
  subreddit?: string | null
}

export interface TrackPostOk {
  ok: true
  data: {
    post_id: string
    external_post_id: string
    subreddit: string
    title: string
    source_url: string
    published_at: string | null
    monitoring_started_at: string
    already_tracked: boolean
  }
}

export interface TrackPostErr {
  ok: false
  error: {
    code:
      | "validation_failed"
      | "not_found"
      | "not_connected"
      | "rate_limited"
      | "upstream_error"
      | "internal"
    message: string
  }
}

interface RedditPostData {
  id: string
  subreddit?: string
  title?: string
  created_utc?: number
  permalink?: string
}

interface RedditInfoResponse {
  data?: {
    children?: Array<{
      kind?: string
      data?: RedditPostData
    }>
  }
}

// Accepts:
//   https://www.reddit.com/r/<sub>/comments/<id>/<slug>/?...
//   https://reddit.com/r/<sub>/comments/<id>
//   https://old.reddit.com/r/<sub>/comments/<id>/...
//   https://redd.it/<id>
//   t3_<id>          (raw thing-id form)
//   <id>             (bare base36 id)
// Subreddit may be missing on the redd.it / raw forms — caller supplies
// it explicitly, or we recover it from the post's data after fetch.
export interface ParsedRedditUrl {
  external_post_id: string
  subreddit_from_url: string | null
  canonical_url: string
}

export function parseRedditUrl(raw: string): ParsedRedditUrl | null {
  const trimmed = String(raw ?? "").trim()
  if (!trimmed) return null

  // Bare id forms.
  if (/^t3_[a-z0-9]+$/i.test(trimmed)) {
    return {
      external_post_id: trimmed.slice(3).toLowerCase(),
      subreddit_from_url: null,
      canonical_url: `https://redd.it/${trimmed.slice(3).toLowerCase()}`,
    }
  }
  if (/^[a-z0-9]{4,16}$/i.test(trimmed)) {
    return {
      external_post_id: trimmed.toLowerCase(),
      subreddit_from_url: null,
      canonical_url: `https://redd.it/${trimmed.toLowerCase()}`,
    }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()

  // redd.it short link
  if (host === "redd.it" || host.endsWith(".redd.it")) {
    const id = url.pathname.replace(/^\//, "").split("/")[0]
    if (!id) return null
    return {
      external_post_id: id.toLowerCase(),
      subreddit_from_url: null,
      canonical_url: `https://redd.it/${id.toLowerCase()}`,
    }
  }

  // reddit.com long link
  if (host === "reddit.com" || host.endsWith(".reddit.com")) {
    // /r/<sub>/comments/<id>/<slug>?...
    const parts = url.pathname.split("/").filter(Boolean)
    const rIdx = parts.indexOf("r")
    const commentsIdx = parts.indexOf("comments")
    if (rIdx >= 0 && commentsIdx === rIdx + 2) {
      const subreddit = parts[rIdx + 1]
      const id = parts[commentsIdx + 1]
      if (subreddit && id) {
        return {
          external_post_id: id.toLowerCase(),
          subreddit_from_url: subreddit,
          canonical_url: `https://www.reddit.com/r/${subreddit}/comments/${id}/`,
        }
      }
    }
    // /comments/<id> short form
    if (commentsIdx === 0) {
      const id = parts[1]
      if (id) {
        return {
          external_post_id: id.toLowerCase(),
          subreddit_from_url: null,
          canonical_url: `https://www.reddit.com/comments/${id}/`,
        }
      }
    }
  }

  return null
}

export async function trackPost(input: TrackPostInput): Promise<TrackPostOk | TrackPostErr> {
  const parsed = parseRedditUrl(input.url)
  if (!parsed) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message:
          "Could not parse a Reddit post id from the URL. Expected a reddit.com/r/<sub>/comments/<id>/... link, a redd.it/<id> short link, or a t3_<id> id.",
      },
    }
  }

  const db = getDb()

  // Already tracked? (Idempotent — return the existing row instead of
  // erroring, so a chat-driven re-add of the same URL doesn't bounce.)
  const existing = db
    .prepare(
      `SELECT id, external_post_id, subreddit, title, source_url, published_at,
              monitoring_started_at, monitoring_completed_at, deleted_at
       FROM reddit_posts
       WHERE external_post_id = ? OR source_url = ?
       LIMIT 1`,
    )
    .get(parsed.external_post_id, parsed.canonical_url) as
    | {
        id: string
        external_post_id: string
        subreddit: string
        title: string | null
        source_url: string | null
        published_at: string | null
        monitoring_started_at: string | null
        monitoring_completed_at: string | null
        deleted_at: string | null
      }
    | undefined

  if (existing) {
    return {
      ok: true,
      data: {
        post_id: existing.id,
        external_post_id: existing.external_post_id,
        subreddit: existing.subreddit,
        title: existing.title ?? "",
        source_url: existing.source_url ?? parsed.canonical_url,
        published_at: existing.published_at,
        monitoring_started_at:
          existing.monitoring_started_at ?? new Date().toISOString(),
        already_tracked: true,
      },
    }
  }

  // Validate via Composio + pull metadata. We need the subreddit name
  // for redd.it short links and the canonical title / created_utc.
  let postData: RedditPostData
  try {
    const response = await reddit.proxy<RedditInfoResponse>({
      method: "GET",
      endpoint: `${REDDIT_API}/api/info?id=t3_${parsed.external_post_id}&raw_json=1`,
    })
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: {
          code: "not_connected",
          message: "Reddit integration not authorized. Connect via Integrations.",
        },
      }
    }
    if (response.status === 429) {
      return {
        ok: false,
        error: {
          code: "rate_limited",
          message: "Reddit rate limited the request. Try again in a minute.",
        },
      }
    }
    if (response.status >= 400) {
      return {
        ok: false,
        error: {
          code: "upstream_error",
          message: `Reddit responded ${response.status}.`,
        },
      }
    }
    const child = response.data?.data?.children?.[0]
    if (!child?.data?.id) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `No Reddit post found for id "${parsed.external_post_id}". The post may have been hard-deleted.`,
        },
      }
    }
    postData = child.data
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "internal",
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }

  const subreddit =
    (input.subreddit ?? "").trim() ||
    parsed.subreddit_from_url ||
    postData.subreddit ||
    ""
  if (!subreddit) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message:
          "Could not infer subreddit from the URL or the upstream post object. Pass `subreddit` explicitly.",
      },
    }
  }

  const now = new Date().toISOString()
  const publishedAt = postData.created_utc
    ? new Date(postData.created_utc * 1000).toISOString()
    : null
  const localId = randomUUID()
  const title = postData.title ?? ""
  const canonicalUrl =
    postData.permalink && postData.permalink.startsWith("/")
      ? `https://www.reddit.com${postData.permalink}`
      : parsed.canonical_url

  insertTrackedPost(db, {
    id: localId,
    title,
    subreddit,
    sourceUrl: canonicalUrl,
    externalPostId: parsed.external_post_id,
    publishedAt,
    monitoringStartedAt: now,
  })

  return {
    ok: true,
    data: {
      post_id: localId,
      external_post_id: parsed.external_post_id,
      subreddit,
      title,
      source_url: canonicalUrl,
      published_at: publishedAt,
      monitoring_started_at: now,
      already_tracked: false,
    },
  }
}

interface InsertParams {
  id: string
  title: string
  subreddit: string
  sourceUrl: string
  externalPostId: string
  publishedAt: string | null
  monitoringStartedAt: string
}

function insertTrackedPost(db: Database.Database, p: InsertParams): void {
  db.prepare(
    `INSERT INTO reddit_posts
       (id, title, content, subreddit, status, external_post_id, source_url,
        published_at, monitoring_started_at, created_at, updated_at)
     VALUES (?, ?, '', ?, 'published', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    p.id,
    p.title,
    p.subreddit,
    p.externalPostId,
    p.sourceUrl,
    p.publishedAt,
    p.monitoringStartedAt,
  )
}

export interface TrackedPostListItem {
  post_id: string
  external_post_id: string | null
  subreddit: string
  title: string
  source_url: string | null
  published_at: string | null
  monitoring_started_at: string | null
  monitoring_completed_at: string | null
  deleted_at: string | null
  deleted_reason: string | null
  views: number | null
  final_score: number | null
  final_num_comments: number | null
  final_upvote_ratio: number | null
}

export function listTrackedPosts(): TrackedPostListItem[] {
  return getDb()
    .prepare(
      `SELECT
         id              AS post_id,
         external_post_id,
         subreddit,
         title,
         source_url,
         published_at,
         monitoring_started_at,
         monitoring_completed_at,
         deleted_at,
         deleted_reason,
         views,
         final_score,
         final_num_comments,
         final_upvote_ratio
       FROM reddit_posts
       WHERE source_url IS NOT NULL
         AND monitoring_started_at IS NOT NULL
       ORDER BY monitoring_started_at DESC`,
    )
    .all() as TrackedPostListItem[]
}

export interface SetViewsResult {
  post_id: string
  views: number
  monitoring_completed_at: string | null
}

export function setPostViews(input: {
  post_id: string
  views: number
}): SetViewsResult | null {
  if (!Number.isFinite(input.views) || input.views < 0) {
    throw new Error("views must be a non-negative number")
  }
  const db = getDb()
  const result = db
    .prepare(
      `UPDATE reddit_posts
         SET views = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(Math.floor(input.views), input.post_id)
  if (result.changes === 0) return null
  const row = db
    .prepare(
      "SELECT id AS post_id, views, monitoring_completed_at FROM reddit_posts WHERE id = ?",
    )
    .get(input.post_id) as
    | { post_id: string; views: number; monitoring_completed_at: string | null }
    | undefined
  return row ?? null
}
