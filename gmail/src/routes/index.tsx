import { Link, createFileRoute } from "@tanstack/react-router"
import { fetchDrafts } from "../server/actions"

export const Route = createFileRoute("/")({
  component: GmailPage,
  loader: () => fetchDrafts(),
})

function GmailPage() {
  const drafts = Route.useLoaderData()
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Gmail</h1>
        <p className="text-sm text-muted-foreground">Email drafts and sending. Use the agent to search threads, draft replies, and send emails.</p>
      </div>
      <div className="space-y-2">
        {drafts.map((d) => (
          <Link
            key={d.id}
            to="/drafts/$draftId"
            params={{ draftId: d.id }}
            className="block rounded-lg border border-border px-4 py-3 transition-colors hover:bg-accent/40"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{d.subject || "(no subject)"}</p>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${d.status === "sent" ? "bg-green-500/10 text-green-600" : d.status === "pending" ? "bg-amber-500/10 text-amber-600" : "bg-gray-500/10 text-gray-600"}`}>{d.status}</span>
            </div>
            <p className="text-xs text-muted-foreground">To: {d.to_email}</p>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{d.body}</p>
          </Link>
        ))}
        {drafts.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">No drafts. Ask the agent to draft an email.</p>}
      </div>
    </div>
  )
}
