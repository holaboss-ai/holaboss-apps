import { Link, createFileRoute } from "@tanstack/react-router"
import { fetchThreadById } from "../server/actions"

export const Route = createFileRoute("/threads/$threadId")({
  loader: ({ params }) => fetchThreadById({ data: { threadId: params.threadId } }),
  component: ThreadDetailPage,
})

function ThreadDetailPage() {
  const thread = Route.useLoaderData()

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back
        </Link>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            CRM-linked thread
          </div>
          <h1 className="mt-2 text-xl font-semibold text-foreground">
            {thread.subject || "Conversation thread"}
          </h1>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                Contact
              </div>
              <div className="mt-1 text-sm font-medium text-foreground">
                {thread.primaryEmail || "Unknown contact"}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                Thread ID
              </div>
              <div className="mt-1 truncate text-sm font-medium text-foreground">
                {thread.id}
              </div>
            </div>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            This conversation stays reopenable from workspace outputs so CRM follow-up can move between Gmail and Sheets without losing context.
          </p>
        </div>

        <div className="space-y-3">
          {thread.messages.map((message) => (
            <article key={message.id} className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {message.subject || "(no subject)"}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    From: {message.from || "Unknown sender"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    To: {message.to || "Unknown recipient"}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {message.date || "Unknown time"}
                </div>
              </div>
              <pre className="mt-4 whitespace-pre-wrap break-words font-[inherit] text-sm leading-6 text-foreground">
                {message.body || message.snippet || "(empty message)"}
              </pre>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
