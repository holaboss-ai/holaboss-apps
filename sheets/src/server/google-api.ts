import { getProviderToken } from "./integration-client"

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets"

let cachedToken: string | null = null

async function resolveToken(): Promise<string> {
  if (cachedToken) return cachedToken
  cachedToken = await getProviderToken("google")
  return cachedToken
}

async function headers(): Promise<Record<string, string>> {
  const token = await resolveToken()
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

async function gfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const hdrs = await headers()
  const res = await fetch(url, { ...init, headers: { ...hdrs, ...init?.headers } })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Sheets API error (${res.status}): ${text.slice(0, 500)}`)
  }
  return res.json() as Promise<T>
}

export interface SheetRow {
  rowNumber: number
  values: Record<string, string>
}

export async function getSheetInfo(sheetId: string): Promise<{ title: string; headers: string[]; rowCount: number }> {
  const data = await gfetch<{ properties: { title: string }; sheets: Array<{ properties: { title: string; gridProperties: { rowCount: number } } }> }>(`${SHEETS_BASE}/${sheetId}?fields=properties.title,sheets.properties`)
  const firstSheet = data.sheets?.[0]
  // Also fetch headers (first row)
  const headerData = await gfetch<{ values?: string[][] }>(`${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(firstSheet?.properties.title ?? "Sheet1")}!1:1`)
  const hdrs = headerData.values?.[0]?.map(h => h.trim().toLowerCase()) ?? []
  return {
    title: data.properties.title,
    headers: hdrs,
    rowCount: firstSheet?.properties.gridProperties.rowCount ?? 0,
  }
}

export async function readRows(sheetId: string, range = "Sheet1"): Promise<SheetRow[]> {
  const data = await gfetch<{ values?: string[][] }>(`${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`)
  const rows = data.values ?? []
  if (rows.length < 2) return []
  const headerRow = rows[0]
  if (!headerRow) return []
  const hdrs = headerRow.map(h => h.trim().toLowerCase())
  const result: SheetRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const values: Record<string, string> = {}
    for (let j = 0; j < hdrs.length; j++) {
      const key = hdrs[j]
      if (key) values[key] = row[j]?.trim() ?? ""
    }
    result.push({ rowNumber: i + 1, values })
  }
  return result
}

export async function readRange(sheetId: string, range: string): Promise<string[][]> {
  const data = await gfetch<{ values?: string[][] }>(`${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`)
  return data.values ?? []
}

function colLetter(index: number): string {
  let result = ""
  let n = index
  while (n > 0) { n--; result = String.fromCharCode(65 + (n % 26)) + result; n = Math.floor(n / 26) }
  return result
}

export async function updateCell(sheetId: string, range: string, value: string): Promise<void> {
  await gfetch(`${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [[value]] }),
  })
}

export async function updateRow(sheetId: string, rowNumber: number, headerCount: number, values: Record<string, string>, headerNames: string[]): Promise<void> {
  const row: string[] = []
  for (let i = 0; i < headerCount; i++) {
    const key = headerNames[i]
    row.push(key ? (values[key] ?? "") : "")
  }
  const range = `Sheet1!A${rowNumber}:${colLetter(headerCount)}${rowNumber}`
  await gfetch(`${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [row] }),
  })
}

export async function appendRow(sheetId: string, range: string, values: string[]): Promise<void> {
  await gfetch(`${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [values] }),
  })
}

export async function createSpreadsheet(title: string, headers: string[], rows: string[][]): Promise<string> {
  const data = await gfetch<{ spreadsheetId: string }>(SHEETS_BASE, {
    method: "POST",
    body: JSON.stringify({ properties: { title } }),
  })
  const sheetId = data.spreadsheetId
  const all = [headers, ...rows]
  await gfetch(`${SHEETS_BASE}/${sheetId}/values/Sheet1!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: all }),
  })
  return sheetId
}

export { colLetter }
