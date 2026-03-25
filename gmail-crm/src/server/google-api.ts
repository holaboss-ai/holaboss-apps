/**
 * Google API client for Gmail and Sheets.
 * Uses raw fetch with OAuth token from platform integration.
 * No googleapis SDK dependency — keeps the module lightweight.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets"

function getToken(): string {
  const token = process.env.PLATFORM_INTEGRATION_TOKEN ?? ""
  if (!token) {
    throw new Error("PLATFORM_INTEGRATION_TOKEN is not set")
  }
  return token
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
  }
}

async function gfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...headers(), ...init?.headers } })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Google API error (${res.status}): ${text.slice(0, 500)}`)
  }
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export interface GmailThread {
  id: string
  historyId: string
  messages: GmailMessage[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds: string[]
  snippet: string
  payload: {
    headers: Array<{ name: string; value: string }>
    mimeType: string
    body?: { data?: string; size: number }
    parts?: Array<{
      mimeType: string
      body?: { data?: string; size: number }
      parts?: Array<{ mimeType: string; body?: { data?: string } }>
    }>
  }
  internalDate: string
}

export interface GmailThreadListResponse {
  threads?: Array<{ id: string; snippet: string }>
  nextPageToken?: string
  resultSizeEstimate: number
}

export async function listThreadsByEmail(
  email: string,
  maxResults = 10
): Promise<Array<{ id: string; snippet: string }>> {
  const q = encodeURIComponent(`from:${email} OR to:${email}`)
  const data = await gfetch<GmailThreadListResponse>(
    `${GMAIL_BASE}/threads?q=${q}&maxResults=${maxResults}`
  )
  return data.threads ?? []
}

export async function getThread(threadId: string): Promise<GmailThread> {
  return gfetch<GmailThread>(
    `${GMAIL_BASE}/threads/${threadId}?format=full`
  )
}

function extractHeader(msg: GmailMessage, name: string): string {
  const header = msg.payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )
  return header?.value ?? ""
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(base64, "base64").toString("utf-8")
}

function extractBody(msg: GmailMessage): string {
  // Try plain text body first
  if (msg.payload.body?.data) {
    return decodeBase64Url(msg.payload.body.data)
  }
  // Check parts for text/plain
  if (msg.payload.parts) {
    for (const part of msg.payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data)
      }
      // Nested multipart
      if (part.parts) {
        for (const sub of part.parts) {
          if (sub.mimeType === "text/plain" && sub.body?.data) {
            return decodeBase64Url(sub.body.data)
          }
        }
      }
    }
    // Fallback to text/html
    for (const part of msg.payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return decodeBase64Url(part.body.data)
      }
    }
  }
  return ""
}

export interface ParsedMessage {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  date: string
  body: string
  snippet: string
  messageId: string
}

export function parseMessage(msg: GmailMessage): ParsedMessage {
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: extractHeader(msg, "From"),
    to: extractHeader(msg, "To"),
    subject: extractHeader(msg, "Subject"),
    date: extractHeader(msg, "Date"),
    body: extractBody(msg),
    snippet: msg.snippet,
    messageId: extractHeader(msg, "Message-ID"),
  }
}

export async function sendEmail(params: {
  to: string
  subject: string
  body: string
  threadId?: string
  inReplyTo?: string
  references?: string
}): Promise<{ id: string; threadId: string }> {
  const lines = [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
  ]
  if (params.inReplyTo) {
    lines.push(`In-Reply-To: ${params.inReplyTo}`)
  }
  if (params.references) {
    lines.push(`References: ${params.references}`)
  }
  lines.push("", params.body)

  const raw = Buffer.from(lines.join("\r\n")).toString("base64url")
  const payload: Record<string, string> = { raw }
  if (params.threadId) {
    payload.threadId = params.threadId
  }

  return gfetch<{ id: string; threadId: string }>(
    `${GMAIL_BASE}/messages/send`,
    { method: "POST", body: JSON.stringify(payload) }
  )
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

export interface SheetRow {
  rowNumber: number
  values: Record<string, string>
}

export async function readSheet(
  sheetId: string,
  range = "Sheet1"
): Promise<SheetRow[]> {
  const data = await gfetch<{ values?: string[][] }>(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`
  )
  const rows = data.values ?? []
  if (rows.length < 2) return []

  const headerRow = rows[0]
  if (!headerRow) return []
  const headers = headerRow.map((h) => h.trim().toLowerCase())

  const result: SheetRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const values: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j]
      if (key) {
        values[key] = row[j]?.trim() ?? ""
      }
    }
    if (values.email) {
      result.push({ rowNumber: i + 1, values })
    }
  }
  return result
}

export async function updateSheetCell(
  sheetId: string,
  range: string,
  value: string
): Promise<void> {
  await gfetch(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      body: JSON.stringify({ values: [[value]] }),
    }
  )
}

export async function appendSheetRow(
  sheetId: string,
  range: string,
  values: string[]
): Promise<void> {
  await gfetch(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({ values: [values] }),
    }
  )
}
