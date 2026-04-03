import { notFound } from "@tanstack/react-router"
import { createFileRoute } from "@tanstack/react-router"
import { fetchDraftById } from "../server/actions"

export const Route = createFileRoute("/drafts/$draftId")({
  loader: async ({ params }) => {
    const draft = await fetchDraftById({ data: { draftId: params.draftId } })
    if (!draft) {
      throw notFound()
    }
    return draft
  },
  component: DraftDetailPage,
})

function statusBadgeClass(status: string): string {
  if (status === "sent") {
    return "bg-green-500/10 text-green-600"
  }
  if (status === "pending") {
    return "bg-amber-500/10 text-amber-600"
  }
  return "bg-gray-500/10 text-gray-600"
}

function DraftDetailPage() {
  const draft = Route.useLoaderData()

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Draft</h1>
            <p className="text-sm text-muted-foreground">
              Review the generated email draft and continue the CRM follow-up flow from here.
            </p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(draft.status)}`}>
            {draft.status}
          </span>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-card/80 p-5 shadow-sm">
        <div className="rounded-lg border border-border bg-background px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            CRM workflow
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            This draft belongs to a contact follow-up flow. Review the draft, then return to the related CRM record to update stage, last contact date, and next action.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border/70 bg-background/70 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              To
            </div>
            <div className="mt-1 text-sm font-medium text-foreground">
              {draft.to_email}
            </div>
          </div>
          <div className="rounded-lg border border-border/70 bg-background/70 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              Thread
            </div>
            <div className="mt-1 truncate text-sm font-medium text-foreground">
              {draft.gmail_thread_id ?? "New conversation"}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border/70 bg-background/70 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            Subject
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            {draft.subject || "(no subject)"}
          </div>
        </div>

        <div className="rounded-lg border border-border/70 bg-background/70 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            Body
          </div>
          <pre className="mt-3 whitespace-pre-wrap break-words font-[inherit] text-sm leading-6 text-foreground">
            {draft.body}
          </pre>
        </div>
      </div>
    </div>
  )
}
