import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"

import {
  fetchProfile,
  fetchContacts,
  fetchEmailsForContact,
  fetchEmailDetail,
  doSendEmail,
  createSampleSheet,
} from "../server/demo-actions"

interface EmailSummary {
  id: string
  from: string
  subject: string
  snippet: string
  date: string
  body?: string
}

interface SheetRow {
  rowNumber: number
  values: Record<string, string>
}

export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [{ title: "Holaboss — Workspace" }],
  }),
  loader: async () => {
    const profile = await fetchProfile()
    return { profile }
  },
  component: DemoPage,
})

/* ─── Types ─── */

interface Contact {
  rowNumber: number
  name: string
  email: string
  company: string
  [key: string]: string | number
}

function rowToContact(row: SheetRow): Contact | null {
  const v = row.values
  const email = v.email || v.mail || v["e-mail"] || ""
  if (!email) return null
  return {
    rowNumber: row.rowNumber,
    name: v.name || v.fullname || v["full name"] || v.contact || email.split("@")[0] || "",
    email,
    company: v.company || v.organization || v.org || "",
  }
}

/* ─── Main Page ─── */

function DemoPage() {
  const { profile } = Route.useLoaderData()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [sheetTitle, setSheetTitle] = useState("")
  const [sheetLoading, setSheetLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [emails, setEmails] = useState<EmailSummary[]>([])
  const [emailsLoading, setEmailsLoading] = useState(false)
  const [selectedEmail, setSelectedEmail] = useState<(EmailSummary & { body?: string }) | null>(null)
  const [emailLoading, setEmailLoading] = useState(false)
  const [showCompose, setShowCompose] = useState(false)

  async function handleCreateSheet() {
    setSheetLoading(true)
    setError(null)
    try {
      const { sheetId } = await createSampleSheet()
      const data = await fetchContacts({ data: { sheetId } })
      setSheetTitle(data.info.title)
      const parsed = data.rows.map(rowToContact).filter((c): c is Contact => c !== null)
      setContacts(parsed)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSheetLoading(false)
    }
  }

  async function selectContact(contact: Contact) {
    setSelectedContact(contact)
    setSelectedEmail(null)
    setShowCompose(false)
    setEmailsLoading(true)
    try {
      const result = await fetchEmailsForContact({ data: { email: contact.email } })
      setEmails(result)
    } finally {
      setEmailsLoading(false)
    }
  }

  async function openEmail(email: EmailSummary) {
    setShowCompose(false)
    setEmailLoading(true)
    try {
      const detail = await fetchEmailDetail({ data: { messageId: email.id } })
      setSelectedEmail(detail)
    } finally {
      setEmailLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Top Bar */}
      <header className="border-b border-border bg-card px-6 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              H
            </div>
            <span className="text-lg font-semibold">Holaboss</span>
            <span className="text-muted-foreground">Workspace</span>
          </div>
          {profile && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">{profile.email}</span>
              <button
                onClick={() => { window.location.href = "/api/auth/logout" }}
                className="group relative"
                title="Disconnect"
              >
                <img
                  src={profile.picture}
                  alt={profile.name}
                  className="h-8 w-8 rounded-full transition-opacity group-hover:opacity-60"
                  referrerPolicy="no-referrer"
                />
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-7xl p-6">
        {/* Step 0: Connect Google account */}
        {!profile && (
          <div className="mx-auto max-w-sm pt-24">
            <div className="rounded-xl border border-border bg-card p-8 text-center shadow-sm">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                <svg className="h-7 w-7" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
              </div>
              <h2 className="mt-4 text-lg font-semibold">Connect Your Google Account</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Sign in to access your emails and spreadsheets
              </p>
              <a
                href="/api/auth/google"
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
              >
                Connect with Google
              </a>
            </div>
          </div>
        )}

        {/* Step 1: Create contacts sheet */}
        {profile && contacts.length === 0 && (
          <div className="mx-auto max-w-sm pt-20">
            <div className="rounded-xl border border-border bg-card p-8 text-center shadow-sm">
              <SheetIcon className="mx-auto h-10 w-10 text-muted-foreground" />
              <h2 className="mt-4 text-lg font-semibold">Get Started</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Create a contacts spreadsheet to manage your network
              </p>
              <button
                onClick={handleCreateSheet}
                disabled={sheetLoading}
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {sheetLoading ? "Creating..." : "Create Contacts Sheet"}
              </button>
              {error && (
                <p className="mt-3 text-sm text-destructive">{error}</p>
              )}
            </div>
          </div>
        )}

        {/* Step 2 & 3: Contacts + Emails */}
        {profile && contacts.length > 0 && (
          <div className="grid grid-cols-[280px_1fr] gap-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            {/* Contacts sidebar */}
            <div className="border-r border-border">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center gap-2">
                  <SheetIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">{sheetTitle}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{contacts.length} contacts</p>
              </div>
              <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
                {contacts.map(c => (
                  <button
                    key={c.rowNumber}
                    onClick={() => selectContact(c)}
                    className={`w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-accent ${
                      selectedContact?.rowNumber === c.rowNumber ? "bg-accent" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase">
                        {c.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                        {c.company && (
                          <p className="truncate text-xs text-muted-foreground">{c.company}</p>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Email area */}
            <div className="flex min-h-[500px] flex-col">
              {!selectedContact && (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-sm text-muted-foreground">Select a contact to view emails</p>
                </div>
              )}

              {selectedContact && (
                <>
                  {/* Contact header */}
                  <div className="flex items-center justify-between border-b border-border px-5 py-3">
                    <div>
                      <h2 className="font-semibold">{selectedContact.name}</h2>
                      <p className="text-sm text-muted-foreground">{selectedContact.email}</p>
                    </div>
                    <button
                      onClick={() => { setShowCompose(true); setSelectedEmail(null) }}
                      className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
                    >
                      Send Email
                    </button>
                  </div>

                  <div className="flex flex-1">
                    {/* Email list */}
                    <div className="w-64 shrink-0 border-r border-border overflow-y-auto">
                      {emailsLoading && (
                        <p className="p-4 text-sm text-muted-foreground">Loading emails...</p>
                      )}
                      {!emailsLoading && emails.length === 0 && (
                        <p className="p-4 text-sm text-muted-foreground">No emails found</p>
                      )}
                      {emails.map(e => (
                        <button
                          key={e.id}
                          onClick={() => openEmail(e)}
                          className={`w-full border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-accent ${
                            selectedEmail?.id === e.id ? "bg-accent" : ""
                          }`}
                        >
                          <p className="truncate text-sm font-medium">
                            {e.subject || "(no subject)"}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {e.from.split("<")[0]?.trim()}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{e.date}</p>
                        </button>
                      ))}
                    </div>

                    {/* Email detail / Compose */}
                    <div className="flex-1 overflow-y-auto p-5">
                      {emailLoading && (
                        <p className="text-sm text-muted-foreground">Loading...</p>
                      )}

                      {showCompose && (
                        <ComposeForm
                          to={selectedContact.email}
                          contactName={selectedContact.name}
                          onSent={() => setShowCompose(false)}
                        />
                      )}

                      {!showCompose && selectedEmail && !emailLoading && (
                        <div>
                          <h3 className="text-base font-semibold">{selectedEmail.subject}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">
                            From: {selectedEmail.from}
                          </p>
                          <p className="text-sm text-muted-foreground">{selectedEmail.date}</p>
                          <div className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">
                            {selectedEmail.body || selectedEmail.snippet}
                          </div>
                        </div>
                      )}

                      {!showCompose && !selectedEmail && !emailLoading && (
                        <p className="mt-16 text-center text-sm text-muted-foreground">
                          Select an email or send a new one
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Compose Form ─── */

function ComposeForm({
  to,
  contactName,
  onSent,
}: {
  to: string
  contactName: string
  onSent: () => void
}) {
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSend() {
    if (!body) return
    setSending(true)
    try {
      await doSendEmail({ data: { to, subject, body } })
      setSent(true)
      setTimeout(onSent, 1500)
    } finally {
      setSending(false)
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <CheckIcon />
        <p className="mt-2 text-sm font-medium text-green-600">Email sent to {contactName}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-semibold">Send email to {contactName}</h3>
      <div className="rounded-lg border border-input bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        To: {to}
      </div>
      <input
        type="text"
        placeholder="Subject"
        value={subject}
        onChange={e => setSubject(e.target.value)}
        className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <textarea
        placeholder="Write your message..."
        value={body}
        onChange={e => setBody(e.target.value)}
        rows={6}
        className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
      />
      <button
        onClick={handleSend}
        disabled={sending || !body}
        className="self-end rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {sending ? "Sending..." : "Send"}
      </button>
    </div>
  )
}

/* ─── Icons ─── */

function SheetIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-5 w-5"} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M10.875 12c-.621 0-1.125.504-1.125 1.125M12 12c.621 0 1.125.504 1.125 1.125m0-1.125c.621 0 1.125.504 1.125 1.125" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  )
}
