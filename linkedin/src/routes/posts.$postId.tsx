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
  const [content, setContent] = useState(post.content)
  const initialScheduledLocal = post.scheduled_at
    ? isoToDatetimeLocal(post.scheduled_at)
    : ""
  const [scheduledAt, setScheduledAt] = useState(initialScheduledLocal)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const hasChanges =
    content !== post.content || scheduledAt !== initialScheduledLocal

  async function doSave() {
    await updatePost({
      data: {
        post_id: post.id,
        content,
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

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Share an insight, idea, or update with your network..."
        className="border-border bg-card focus:ring-ring min-h-[200px] w-full rounded-lg border p-4 text-sm leading-relaxed focus:ring-2 focus:outline-none"
        maxLength={3000}
        autoFocus
      />
      <div className="mt-1 flex items-center justify-between">
        <span
          className={`text-xs ${content.length > 2900 ? "text-destructive" : "text-muted-foreground"}`}
        >
          {content.length}/3,000
        </span>
      </div>

      <div className="mt-4 rounded-lg border border-border p-3">
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
          disabled={publishing || !content.trim()}
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
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {post.content}
        </p>
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
