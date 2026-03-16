import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router"
import { useState } from "react"

import { Button } from "../components/ui/button"
import type { PostRecord } from "../lib/types"
import {
  cancelSchedule,
  deletePost,
  fetchPost,
  publishPost,
  updatePost,
} from "../server/actions"

export const Route = createFileRoute("/posts/$postId")({
  component: PostPage,
  loader: ({ params }) => fetchPost({ data: { post_id: params.postId } }),
})

function PostPage() {
  const post = Route.useLoaderData()

  if (post.status === "draft" || post.status === "failed") {
    return <PostEditor post={post} />
  }

  return <PostDetail post={post} />
}

const statusStyles: Record<string, string> = {
  draft: "bg-yellow-500/10 text-yellow-600",
  queued: "bg-blue-500/10 text-blue-600",
  published: "bg-green-500/10 text-green-600",
  failed: "bg-red-500/10 text-red-600",
  scheduled: "bg-purple-500/10 text-purple-600",
}

function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function PostEditor({ post }: { post: PostRecord }) {
  const router = useRouter()
  const navigate = useNavigate()
  const [title, setTitle] = useState(post.title)
  const [content, setContent] = useState(post.content)
  const [subreddit, setSubreddit] = useState(post.subreddit)
  const initialScheduledLocal = post.scheduled_at
    ? isoToDatetimeLocal(post.scheduled_at)
    : ""
  const [scheduledAt, setScheduledAt] = useState(initialScheduledLocal)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const hasChanges =
    title !== post.title ||
    content !== post.content ||
    subreddit !== post.subreddit ||
    scheduledAt !== initialScheduledLocal

  async function doSave() {
    await updatePost({
      data: {
        post_id: post.id,
        title,
        content,
        subreddit,
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      },
    })
  }

  async function handleSave() {
    setSaving(true)
    try {
      await doSave()
      router.invalidate()
    } finally {
      setSaving(false)
    }
  }

  async function handlePublish() {
    if (hasChanges) await doSave()
    setPublishing(true)
    try {
      await publishPost({ data: { post_id: post.id } })
      router.invalidate()
    } finally {
      setPublishing(false)
    }
  }

  async function handleDelete() {
    await deletePost({ data: { post_id: post.id } })
    navigate({ to: "/" })
  }

  const minDatetime = new Date().toISOString().slice(0, 16)

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <Link
          to="/"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          &larr; Posts
        </Link>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[post.status] ?? ""}`}
          >
            {post.status}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleDelete}
            className="text-muted-foreground"
          >
            Delete
          </Button>
        </div>
      </div>

      {post.status === "failed" && post.error_message && (
        <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
          <p className="text-xs font-medium text-destructive">
            Previous publish failed
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {post.error_message}
          </p>
        </div>
      )}

      <div className="mb-3">
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          Subreddit
        </label>
        <div className="flex items-center">
          <span className="text-muted-foreground border-border bg-muted rounded-l-md border border-r-0 px-2.5 py-1.5 text-sm">
            r/
          </span>
          <input
            type="text"
            value={subreddit}
            onChange={(e) => setSubreddit(e.target.value)}
            placeholder="askreddit"
            className="border-border bg-card focus:ring-ring w-full rounded-r-md border px-3 py-1.5 text-sm focus:ring-2 focus:outline-none"
          />
        </div>
      </div>

      <div className="mb-3">
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="An interesting, descriptive title"
          maxLength={300}
          className="border-border bg-card focus:ring-ring w-full rounded-md border px-3 py-2 text-sm font-medium focus:ring-2 focus:outline-none"
          autoFocus
        />
        <div className="mt-0.5 text-right">
          <span
            className={`text-xs ${title.length > 280 ? "text-destructive" : "text-muted-foreground"}`}
          >
            {title.length}/300
          </span>
        </div>
      </div>

      <div className="mb-3">
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          Body
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write your post body here... (markdown supported)"
          className="border-border bg-card focus:ring-ring min-h-[160px] w-full rounded-md border p-3 text-sm leading-relaxed focus:ring-2 focus:outline-none"
          maxLength={40000}
        />
        <div className="mt-0.5 text-right">
          <span className="text-muted-foreground text-xs">
            {content.length.toLocaleString()}/40,000
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
          Schedule for
        </label>
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            min={minDatetime}
            className="border-border bg-card focus:ring-ring rounded-md border px-3 py-1.5 text-sm focus:ring-2 focus:outline-none"
          />
          {scheduledAt && (
            <button
              type="button"
              onClick={() => setScheduledAt("")}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          variant="outline"
          size="sm"
        >
          {saving ? "Saving..." : "Save Draft"}
        </Button>
        <Button
          onClick={handlePublish}
          disabled={publishing || !title.trim() || !subreddit.trim()}
          size="sm"
        >
          {publishing
            ? "Publishing..."
            : scheduledAt
              ? "Schedule"
              : "Publish Now"}
        </Button>
      </div>

      <div className="text-muted-foreground mt-6 text-xs">
        <p>Created {new Date(post.created_at).toLocaleString()}</p>
        {post.updated_at !== post.created_at && (
          <p>Updated {new Date(post.updated_at).toLocaleString()}</p>
        )}
      </div>
    </div>
  )
}

function PostDetail({ post }: { post: PostRecord }) {
  const router = useRouter()
  const navigate = useNavigate()

  async function handleDelete() {
    await deletePost({ data: { post_id: post.id } })
    navigate({ to: "/" })
  }

  async function handleCancelSchedule() {
    await cancelSchedule({ data: { post_id: post.id } })
    router.invalidate()
  }

  async function handleRetry() {
    await publishPost({ data: { post_id: post.id } })
    router.invalidate()
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <Link
          to="/"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          &larr; Posts
        </Link>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[post.status] ?? ""}`}
          >
            {post.status}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleDelete}
            className="text-muted-foreground"
          >
            Delete
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        {post.subreddit && (
          <p className="text-muted-foreground mb-1 text-xs font-medium">
            r/{post.subreddit}
          </p>
        )}
        <h2 className="mb-2 text-base font-semibold">{post.title}</h2>
        {post.content && (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {post.content}
          </p>
        )}
      </div>

      {post.status === "scheduled" && post.scheduled_at && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-purple-500/20 bg-purple-500/5 p-3">
          <div>
            <p className="text-xs font-medium text-purple-600">Scheduled for</p>
            <p className="text-sm">
              {new Date(post.scheduled_at).toLocaleString()}
            </p>
          </div>
          <Button variant="outline" size="xs" onClick={handleCancelSchedule}>
            Cancel
          </Button>
        </div>
      )}

      {post.status === "queued" && (
        <div className="mt-4 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
          <p className="text-xs font-medium text-blue-600">Publishing...</p>
          <p className="text-muted-foreground mt-1 text-xs">
            This post is being processed.
          </p>
        </div>
      )}

      {post.status === "published" && post.published_at && (
        <div className="mt-4 rounded-lg border border-green-500/20 bg-green-500/5 p-3">
          <p className="text-xs font-medium text-green-600">Published</p>
          <p className="text-sm">
            {new Date(post.published_at).toLocaleString()}
          </p>
          {post.external_post_id && (
            <p className="text-muted-foreground mt-1 text-xs">
              External ID: {post.external_post_id}
            </p>
          )}
        </div>
      )}

      <div className="text-muted-foreground mt-6 text-xs">
        <p>Created {new Date(post.created_at).toLocaleString()}</p>
        {post.updated_at !== post.created_at && (
          <p>Updated {new Date(post.updated_at).toLocaleString()}</p>
        )}
      </div>
    </div>
  )
}
