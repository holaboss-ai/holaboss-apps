import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useState } from "react"

import { createPost, deletePost, fetchPosts, publishPost } from "../server/actions"

export const Route = createFileRoute("/")({
  component: HomePage,
  loader: () => fetchPosts(),
})

function HomePage() {
  const posts = Route.useLoaderData()
  const router = useRouter()
  const [content, setContent] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim() || loading) return
    setLoading(true)
    try {
      await createPost({ data: { content } })
      setContent("")
      router.invalidate()
    } finally {
      setLoading(false)
    }
  }

  async function handlePublish(postId: string) {
    await publishPost({ data: { post_id: postId } })
    router.invalidate()
  }

  async function handleDelete(postId: string) {
    await deletePost({ data: { post_id: postId } })
    router.invalidate()
  }

  const statusColors: Record<string, string> = {
    draft: "bg-yellow-500/10 text-yellow-600",
    queued: "bg-blue-500/10 text-blue-600",
    published: "bg-green-500/10 text-green-600",
    failed: "bg-red-500/10 text-red-600",
    scheduled: "bg-purple-500/10 text-purple-600",
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      {/* TODO: Replace with your module name */}
      <h1 className="mb-1 text-2xl font-semibold">Module Template</h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Create, manage, and publish content
      </p>

      <form onSubmit={handleCreate} className="mb-8">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What's happening?"
          className="border-border bg-card focus:ring-ring w-full resize-none rounded-lg border p-3 text-sm focus:ring-2 focus:outline-none"
          rows={3}
          maxLength={280}
        />
        <div className="mt-2 flex items-center justify-between">
          <span
            className={`text-xs ${content.length > 260 ? "text-red-500" : "text-muted-foreground"}`}
          >
            {content.length}/280
          </span>
          <button
            type="submit"
            disabled={!content.trim() || loading}
            className="bg-primary text-primary-foreground disabled:opacity-50 rounded-md px-4 py-2 text-sm font-medium"
          >
            {loading ? "Creating..." : "Create Draft"}
          </button>
        </div>
      </form>

      <div className="space-y-3">
        {posts.map((post) => (
          <div key={post.id} className="border-border rounded-lg border p-4">
            <p className="mb-3 text-sm whitespace-pre-wrap">{post.content}</p>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[post.status] ?? ""}`}
                >
                  {post.status}
                </span>
                <span className="text-muted-foreground text-xs">
                  {new Date(post.created_at).toLocaleString()}
                </span>
              </div>
              <div className="flex gap-2">
                {post.status === "draft" && (
                  <button
                    type="button"
                    onClick={() => handlePublish(post.id)}
                    className="bg-primary text-primary-foreground rounded px-3 py-1 text-xs font-medium"
                  >
                    Publish
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(post.id)}
                  className="text-muted-foreground hover:text-foreground rounded px-2 py-1 text-xs"
                >
                  Delete
                </button>
              </div>
            </div>
            {post.error_message && (
              <p className="mt-2 text-xs text-red-500">{post.error_message}</p>
            )}
          </div>
        ))}

        {posts.length === 0 && (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No posts yet. Create your first draft above.
          </p>
        )}
      </div>
    </div>
  )
}
