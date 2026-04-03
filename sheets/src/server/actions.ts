import { createServerFn } from "@tanstack/react-start"
import { getSheetInfo, readRows } from "./google-api"

export const fetchStatus = createServerFn({ method: "GET" }).handler(async () => {
  return { ready: true, message: "Use the agent to read and write Google Sheets." }
})

export interface ContactRowData {
  spreadsheetId: string
  sheetName: string
  rowNumber: number
  sheetTitle: string
  values: Record<string, string>
}

export const fetchContactRow = createServerFn({ method: "GET" })
  .inputValidator((data: { contactRef: string }) => data)
  .handler(async ({ data }): Promise<ContactRowData> => {
    const parts = data.contactRef.split(":")
    if (parts.length < 3) {
      throw new Error(`Invalid contact reference: ${data.contactRef}`)
    }
    const spreadsheetId = parts[0]
    const sheetName = parts[1]
    const rowNumber = parseInt(parts[2], 10)
    if (Number.isNaN(rowNumber) || rowNumber < 1) {
      throw new Error(`Invalid row number in contact reference: ${data.contactRef}`)
    }

    const info = await getSheetInfo(spreadsheetId)
    const rows = await readRows(spreadsheetId, sheetName)
    const row = rows.find(r => r.rowNumber === rowNumber)
    if (!row) {
      throw new Error(`Row ${rowNumber} not found in ${sheetName}`)
    }

    return {
      spreadsheetId,
      sheetName,
      rowNumber,
      sheetTitle: info.title,
      values: row.values,
    }
  })
