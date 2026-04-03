import { createIntegrationClient } from "./holaboss-bridge"

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets"
const google = createIntegrationClient("googlesheets")

async function gfetch<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const result = await google.proxy<T>({
    method: (init?.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    endpoint: url,
    ...(init?.body !== undefined ? { body: init.body } : {}),
  })
  if (result.status >= 400) {
    throw new Error(`Sheets API error (${result.status}): ${JSON.stringify(result.data).slice(0, 500)}`)
  }
  return result.data as T
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
    body: { values: [[value]] },
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
    body: { values: [row] },
  })
}

export async function appendRow(sheetId: string, range: string, values: string[]): Promise<void> {
  await gfetch(`${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: { values: [values] },
  })
}

export async function createSpreadsheet(title: string, headers: string[], rows: string[][]): Promise<string> {
  const data = await gfetch<{ spreadsheetId: string }>(SHEETS_BASE, {
    method: "POST",
    body: { properties: { title } },
  })
  const sheetId = data.spreadsheetId
  const all = [headers, ...rows]
  await gfetch(`${SHEETS_BASE}/${sheetId}/values/Sheet1!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: { values: all },
  })
  return sheetId
}

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files"

export async function listSpreadsheets(query?: string): Promise<Array<{ id: string; name: string; modifiedTime: string }>> {
  let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
  if (query) {
    const escaped = query.replace(/'/g, "\\'")
    q += ` and name contains '${escaped}'`
  }
  const data = await gfetch<{ files?: Array<{ id: string; name: string; modifiedTime: string }> }>(
    `${DRIVE_FILES}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`,
  )
  return data.files ?? []
}

export async function deleteRow(sheetId: string, sheetTabName: string, rowNumber: number): Promise<void> {
  // Resolve the numeric sheet (tab) ID from the tab name
  const meta = await gfetch<{ sheets: Array<{ properties: { title: string; sheetId: number } }> }>(
    `${SHEETS_BASE}/${sheetId}?fields=sheets.properties`,
  )
  const tab = meta.sheets.find(s => s.properties.title.toLowerCase() === sheetTabName.toLowerCase())
  if (!tab) {
    throw new Error(`Sheet tab "${sheetTabName}" not found`)
  }

  await gfetch(`${SHEETS_BASE}/${sheetId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: tab.properties.sheetId,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      }],
    },
  })
}

export async function addSheet(sheetId: string, title: string): Promise<{ sheetId: number; title: string }> {
  const data = await gfetch<{ replies: Array<{ addSheet: { properties: { sheetId: number; title: string } } }> }>(
    `${SHEETS_BASE}/${sheetId}:batchUpdate`,
    {
      method: "POST",
      body: {
        requests: [{
          addSheet: { properties: { title } },
        }],
      },
    },
  )
  const added = data.replies?.[0]?.addSheet?.properties
  return { sheetId: added?.sheetId ?? 0, title: added?.title ?? title }
}

export { colLetter }
