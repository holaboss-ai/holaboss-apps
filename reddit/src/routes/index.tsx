import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"

import { Button } from "../components/ui/button"
import { createPost, fetchPosts } from "../server/actions"

/** SQLite datetime('now') stores UTC without timezone marker — append Z so JS parses as UTC */
function utc(dateStr: string): Date {
  return new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`)
}

const statusFilters = ["all", "draft", "scheduled", "queued", "published", "failed"] as const

const statusStyles: Record<string, string> = {
  draft: "bg-yellow-500/10 text-yellow-600",
  queued: "bg-blue-500/10 text-blue-600",
  published: "bg-green-500/10 text-green-600",
  failed: "bg-red-500/10 text-red-600",
  scheduled: "bg-purple-500/10 text-purple-600",
}

export const Route = createFileRoute("/")({
  component: PostsPage,
  loader: () => fetchPosts(),
  validateSearch: (search: Record<string, unknown>) => ({
    status: (search.status as string) || "all",
  }),
})

function PostsPage() {
  const posts = Route.useLoaderData()
  const { status } = Route.useSearch()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  const filtered =
    status === "all" ? posts : posts.filter((p) => p.status === status)

  async function handleNewPost() {
    if (creating) return
    setCreating(true)
    try {
      const post = await createPost({ data: { title: "", content: "", subreddit: "" } })
      navigate({ to: "/posts/$postId", params: { postId: post.id } })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Reddit</h1>
          <p className="text-muted-foreground text-sm">Manage your posts</p>
        </div>
        <Button onClick={handleNewPost} disabled={creating} size="sm">
          {creating ? "Creating..." : "+ New Post"}
        </Button>
      </div>

      <div className="mb-4 flex gap-1 border-b border-border">
        {statusFilters.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => navigate({ search: { status: s } })}
            className={`px-3 py-2 text-xs capitalize transition-colors ${
              status === s
                ? "border-b-2 border-foreground font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {filtered.map((post) => (
          <Link
            key={post.id}
            to="/posts/$postId"
            params={{ postId: post.id }}
            className="block rounded-lg border border-border p-4 transition-colors hover:bg-muted/50"
          >
            <div className="mb-1 flex items-center gap-2">
              {post.subreddit && (
                <span className="text-muted-foreground text-xs font-medium">
                  r/{post.subreddit}
                </span>
              )}
            </div>
            <p className="mb-1 line-clamp-1 text-sm font-medium">
              {post.title || (
                <span className="text-muted-foreground italic font-normal">Untitled</span>
              )}
            </p>
            {post.content && (
              <p className="text-muted-foreground mb-2 line-clamp-1 text-xs">
                {post.content}
              </p>
            )}
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[post.status] ?? ""}`}
              >
                {post.status}
              </span>
              {post.scheduled_at && (
                <span className="text-muted-foreground text-xs">
                  {utc(post.scheduled_at).toLocaleString()}
                </span>
              )}
              {post.published_at && (
                <span className="text-muted-foreground text-xs">
                  {utc(post.published_at).toLocaleString()}
                </span>
              )}
              {!post.scheduled_at && !post.published_at && (
                <span className="text-muted-foreground text-xs">
                  {utc(post.created_at).toLocaleString()}
                </span>
              )}
            </div>
            {post.error_message && (
              <p className="mt-1 text-xs text-destructive">{post.error_message}</p>
            )}
          </Link>
        ))}

        {filtered.length === 0 && (
          <p className="text-muted-foreground py-12 text-center text-sm">
            {status === "all"
              ? "No posts yet. Create your first post."
              : `No ${status} posts.`}
          </p>
        )}
      </div>
    </div>
  )
}
