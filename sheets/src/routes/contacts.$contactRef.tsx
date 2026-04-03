import { createFileRoute, Link } from "@tanstack/react-router"
import { fetchContactRow } from "../server/actions"

export const Route = createFileRoute("/contacts/$contactRef")({
  head: () => ({
    meta: [{ title: "Holaboss — Contact Detail" }],
  }),
  loader: ({ params }) => fetchContactRow({ data: { contactRef: params.contactRef } }),
  component: ContactDetailPage,
})

function ContactDetailPage() {
  const contact = Route.useLoaderData()
  const normalizedEntries = Object.entries(contact.values).map(([key, value]) => [
    key,
    key.trim().toLowerCase(),
    value,
  ] as const)

  const pickField = (...keys: string[]) =>
    normalizedEntries.find(([, normalizedKey]) => keys.includes(normalizedKey))?.[2] ?? ""

  const name = pickField("name", "fullname", "full name", "contact") || "Unknown"
  const email = pickField("email", "mail", "e-mail")
  const company = pickField("company", "organization")
  const stage = pickField("stage")
  const owner = pickField("owner")
  const lastContactedAt = pickField("last contacted at", "last_contacted_at")
  const nextAction = pickField("next action", "next_action")

  const reservedKeys = new Set([
    "name",
    "fullname",
    "full name",
    "contact",
    "email",
    "mail",
    "e-mail",
    "company",
    "organization",
    "stage",
    "owner",
    "last contacted at",
    "last_contacted_at",
    "next action",
    "next_action",
  ])

  const otherFields = normalizedEntries.filter(([, normalizedKey]) => !reservedKeys.has(normalizedKey))

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-4">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back
        </Link>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-lg font-semibold uppercase">
            {name.charAt(0)}
          </div>
          <div>
            <h1 className="text-lg font-semibold">{name}</h1>
            {email && <p className="text-sm text-muted-foreground">{email}</p>}
            {company && <p className="text-sm text-muted-foreground">{company}</p>}
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border px-3 py-3">
              <div className="text-xs text-muted-foreground">Stage</div>
              <div className="mt-1 text-sm font-medium">{stage || "Unspecified"}</div>
            </div>
            <div className="rounded-md border border-border px-3 py-3">
              <div className="text-xs text-muted-foreground">Owner</div>
              <div className="mt-1 text-sm font-medium">{owner || "Unassigned"}</div>
            </div>
            <div className="rounded-md border border-border px-3 py-3">
              <div className="text-xs text-muted-foreground">Last Contacted</div>
              <div className="mt-1 text-sm font-medium">{lastContactedAt || "Not recorded"}</div>
            </div>
            <div className="rounded-md border border-border px-3 py-3">
              <div className="text-xs text-muted-foreground">Next Action</div>
              <div className="mt-1 text-sm font-medium">{nextAction || "No next action"}</div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">Sheet</span>
            <span className="text-xs font-medium">{contact.sheetTitle}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">Row</span>
            <span className="text-xs font-medium">{contact.rowNumber}</span>
          </div>
          {otherFields.map(([key, , value]) => (
            <div key={key} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="text-xs text-muted-foreground capitalize">{key}</span>
              <span className="text-xs font-medium">{value}</span>
            </div>
          ))}
        </div>

        <p className="mt-6 text-xs text-muted-foreground">
          This contact is managed via Google Sheets. Use the agent to update CRM fields, draft follow-up emails, or track engagement.
        </p>
      </div>
    </div>
  )
}
