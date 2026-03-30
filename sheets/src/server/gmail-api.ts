import { getProviderToken } from "./integration-client"

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

let cachedToken: string | null = null

async function resolveToken(): Promise<string> {
  if (cachedToken) return cachedToken
  cachedToken = await getProviderToken("google")
  return cachedToken
}

async function headers(): Promise<Record<string, string>> {
  const token = await resolveToken()
  return { Authorization: `Bearer ${token}` }
}

async function gfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const hdrs = await headers()
  const res = await fetch(url, { ...init, headers: { ...hdrs, ...init?.headers } })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Google API error (${res.status}): ${text.slice(0, 500)}`)
  }
  return res.json() as Promise<T>
}

export interface UserProfile {
  email: string
  name: string
  picture: string
}

export async function getUserProfile(): Promise<UserProfile> {
  const data = await gfetch<{ email: string; name: string; picture: string }>(USERINFO_URL)
  return { email: data.email, name: data.name, picture: data.picture }
}

interface GmailMessage {
  id: string
  payload: {
    headers: Array<{ name: string; value: string }>
    parts?: Array<{ mimeType: string; body: { data?: string } }>
    body?: { data?: string }
  }
  snippet: string
  internalDate: string
}

function extractHeader(msg: GmailMessage, name: string): string {
  return msg.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ""
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
}

function extractBody(msg: GmailMessage): string {
  if (msg.payload.parts) {
    const textPart = msg.payload.parts.find(p => p.mimeType === "text/plain")
    if (textPart?.body?.data) return decodeBase64Url(textPart.body.data)
  }
  if (msg.payload.body?.data) return decodeBase64Url(msg.payload.body.data)
  return msg.snippet
}

export interface EmailSummary {
  id: string
  from: string
  subject: string
  snippet: string
  date: string
  body?: string
}

export async function listEmails(maxResults = 10, query?: string): Promise<EmailSummary[]> {
  const params = new URLSearchParams({ maxResults: String(maxResults) })
  if (query) params.set("q", query)
  const data = await gfetch<{ messages?: Array<{ id: string }> }>(
    `${GMAIL_BASE}/messages?${params}`,
  )
  if (!data.messages?.length) return []

  const emails: EmailSummary[] = []
  for (const m of data.messages.slice(0, maxResults)) {
    const msg = await gfetch<GmailMessage>(`${GMAIL_BASE}/messages/${m.id}?format=full`)
    emails.push({
      id: msg.id,
      from: extractHeader(msg, "From"),
      subject: extractHeader(msg, "Subject"),
      snippet: msg.snippet,
      date: new Date(Number(msg.internalDate)).toLocaleDateString(),
    })
  }
  return emails
}

export async function getEmail(messageId: string): Promise<EmailSummary & { body: string }> {
  const msg = await gfetch<GmailMessage>(`${GMAIL_BASE}/messages/${messageId}?format=full`)
  return {
    id: msg.id,
    from: extractHeader(msg, "From"),
    subject: extractHeader(msg, "Subject"),
    snippet: msg.snippet,
    date: new Date(Number(msg.internalDate)).toLocaleDateString(),
    body: extractBody(msg),
  }
}

export async function sendEmail(to: string, subject: string, body: string): Promise<{ id: string }> {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n")

  const encoded = Buffer.from(raw).toString("base64url")

  const res = await gfetch<{ id: string }>(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  })
  return res
}
