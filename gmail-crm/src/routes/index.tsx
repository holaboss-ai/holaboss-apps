import { createFileRoute } from "@tanstack/react-router"

import { STAGES } from "../lib/types"
import { fetchContacts } from "../server/actions"

const stageStyles: Record<string, string> = {
  lead: "bg-gray-500/10 text-gray-600",
  contacted: "bg-blue-500/10 text-blue-600",
  interested: "bg-yellow-500/10 text-yellow-600",
  negotiating: "bg-purple-500/10 text-purple-600",
  "closed-won": "bg-green-500/10 text-green-600",
  "closed-lost": "bg-red-500/10 text-red-600",
}

export const Route = createFileRoute("/")({
  component: ContactsPage,
  loader: () => fetchContacts(),
  validateSearch: (search: Record<string, unknown>) => ({
    stage: (search.stage as string) || "all",
  }),
})

function ContactsPage() {
  const contacts = Route.useLoaderData()
  const { stage } = Route.useSearch()

  const filtered =
    stage === "all" ? contacts : contacts.filter((c) => c.stage === stage)

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Gmail CRM</h1>
        <p className="text-muted-foreground text-sm">
          Contacts synced from Google Sheets. Use the agent to manage contacts
          and send emails.
        </p>
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        <StageTab label="All" value="all" active={stage} />
        {STAGES.map((s) => (
          <StageTab key={s} label={s} value={s} active={stage} />
        ))}
      </div>

      <div className="space-y-1">
        {filtered.map((contact) => (
          <div
            key={contact.id}
            className="flex items-center gap-4 rounded-lg border border-border px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {contact.name || contact.email}
              </p>
              {contact.name && (
                <p className="truncate text-xs text-muted-foreground">
                  {contact.email}
                  {contact.company ? ` · ${contact.company}` : ""}
                </p>
              )}
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${stageStyles[contact.stage] ?? ""}`}
            >
              {contact.stage}
            </span>
            {contact.last_contact_at && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {new Date(contact.last_contact_at).toLocaleDateString()}
              </span>
            )}
          </div>
        ))}

        {filtered.length === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {stage === "all"
              ? 'No contacts yet. Ask the agent to "sync contacts" from your Google Sheet.'
              : `No ${stage} contacts.`}
          </p>
        )}
      </div>
    </div>
  )
}

function StageTab({
  label,
  value,
  active,
}: {
  label: string
  value: string
  active: string
}) {
  return (
    <a
      href={`?stage=${value}`}
      className={`whitespace-nowrap px-3 py-2 text-xs capitalize transition-colors ${
        active === value
          ? "border-b-2 border-foreground font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </a>
  )
}
