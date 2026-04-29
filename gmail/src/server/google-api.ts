import { createIntegrationClient } from "./holaboss-bridge"

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
const google = createIntegrationClient("gmail")

async function gfetch<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const result = await google.proxy<T>({
    method: (init?.method ?? "GET") as "GET" | "POST",
    endpoint: url,
    ...(init?.body !== undefined ? { body: init.body } : {})
  })
  if (result.status >= 400) {
    throw new Error(`Gmail API error (${result.status}): ${JSON.stringify(result.data).slice(0, 500)}`)
  }
  return result.data as T
}

export interface GmailMessage {
  id: string
  threadId: string
  snippet: string
  payload: {
    headers: Array<{ name: string; value: string }>
    mimeType: string
    body?: { data?: string; size: number }
    parts?: Array<{ mimeType: string; body?: { data?: string; size: number }; parts?: Array<{ mimeType: string; body?: { data?: string } }> }>
  }
  internalDate: string
}

export interface GmailThread { id: string; messages: GmailMessage[] }

export async function listThreads(query: string, maxResults = 10): Promise<Array<{ id: string; snippet: string }>> {
  const q = encodeURIComponent(query)
  const data = await gfetch<{ threads?: Array<{ id: string; snippet: string }> }>(`${GMAIL_BASE}/threads?q=${q}&maxResults=${maxResults}`)
  return data.threads ?? []
}

export async function getThread(threadId: string): Promise<GmailThread> {
  return gfetch<GmailThread>(`${GMAIL_BASE}/threads/${threadId}?format=full`)
}

function extractHeader(msg: GmailMessage, name: string): string {
  return msg.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ""
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
}

function extractBody(msg: GmailMessage): string {
  if (msg.payload.body?.data) return decodeBase64Url(msg.payload.body.data)
  if (msg.payload.parts) {
    for (const part of msg.payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data)
      if (part.parts) { for (const sub of part.parts) { if (sub.mimeType === "text/plain" && sub.body?.data) return decodeBase64Url(sub.body.data) } }
    }
    for (const part of msg.payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) return decodeBase64Url(part.body.data)
    }
  }
  return ""
}

export interface ParsedMessage { id: string; threadId: string; from: string; to: string; subject: string; date: string; body: string; snippet: string; messageId: string }

export function parseMessage(msg: GmailMessage): ParsedMessage {
  return { id: msg.id, threadId: msg.threadId, from: extractHeader(msg, "From"), to: extractHeader(msg, "To"), subject: extractHeader(msg, "Subject"), date: extractHeader(msg, "Date"), body: extractBody(msg), snippet: msg.snippet, messageId: extractHeader(msg, "Message-ID") }
}

export async function sendEmail(params: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string; references?: string }): Promise<{ id: string; threadId: string }> {
  const lines = [`To: ${params.to}`, `Subject: ${params.subject}`, "Content-Type: text/plain; charset=utf-8", "MIME-Version: 1.0"]
  if (params.inReplyTo) lines.push(`In-Reply-To: ${params.inReplyTo}`)
  if (params.references) lines.push(`References: ${params.references}`)
  lines.push("", params.body)
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url")
  const payload: Record<string, string> = { raw }
  if (params.threadId) payload.threadId = params.threadId
  return gfetch<{ id: string; threadId: string }>(`${GMAIL_BASE}/messages/send`, { method: "POST", body: payload })
}

export async function searchEmails(query: string, maxResults = 10): Promise<Array<{ id: string; threadId: string; snippet: string }>> {
  const q = encodeURIComponent(query)
  const data = await gfetch<{ messages?: Array<{ id: string; threadId: string; snippet: string }> }>(`${GMAIL_BASE}/messages?q=${q}&maxResults=${maxResults}`)
  return data.messages ?? []
}

// Sync helpers — used by sync.ts. Same proxy auth as the rest, but
// with a result envelope instead of throw, so the sync engine can
// treat 429 / 4xx as soft errors and keep running.

export interface ThreadListResponse {
  threads?: Array<{ id: string; historyId?: string; snippet?: string }>
  nextPageToken?: string
  resultSizeEstimate?: number
}

export interface ThreadMetadataResponse {
  id: string
  historyId?: string
  messages?: Array<{
    id: string
    labelIds?: string[]
    snippet?: string
    payload?: { headers?: Array<{ name: string; value: string }> }
    internalDate?: string
  }>
}

export async function gmailProxy<T>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<{ data: T | null; status: number; headers: Record<string, string> }> {
  return google.proxy<T>({
    method: (init?.method ?? "GET") as "GET" | "POST",
    endpoint: url,
    ...(init?.body !== undefined ? { body: init.body } : {}),
  })
}

export const GMAIL_API_BASE = GMAIL_BASE
