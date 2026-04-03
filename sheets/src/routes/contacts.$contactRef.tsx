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
  const name = contact.values.name || contact.values.fullname || contact.values.contact || "Unknown"
  const email = contact.values.email || contact.values.mail || ""
  const company = contact.values.company || contact.values.organization || ""

  const otherFields = Object.entries(contact.values).filter(
    ([key]) => !["name", "fullname", "contact", "email", "mail", "company", "organization"].includes(key.toLowerCase()),
  )

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
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">Sheet</span>
            <span className="text-xs font-medium">{contact.sheetTitle}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">Row</span>
            <span className="text-xs font-medium">{contact.rowNumber}</span>
          </div>
          {otherFields.map(([key, value]) => (
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
