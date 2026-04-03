import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer } from "node:http"
import { z } from "zod"

import { MODULE_CONFIG } from "../lib/types"
import { getSheetInfo, readRows, readRange, updateCell, appendRow, createSpreadsheet } from "./google-api"
import { contactRef, publishContactRowOutput } from "./app-outputs"

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true }
}

function findEmailColumnIndex(headers: string[]): number {
  return headers.findIndex(h => {
    const lower = h.trim().toLowerCase()
    return lower === "email" || lower === "mail" || lower === "e-mail"
  })
}

function findNameColumnIndex(headers: string[]): number {
  return headers.findIndex(h => {
    const lower = h.trim().toLowerCase()
    return lower === "name" || lower === "fullname" || lower === "full name" || lower === "contact"
  })
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: `${MODULE_CONFIG.name} Module`,
    version: "1.0.0",
  })

  server.tool("sheets_get_info", "Get sheet title, headers, and row count", {
    sheet_id: z.string().describe("Google Sheets spreadsheet ID"),
  }, async ({ sheet_id }) => {
    try {
      const info = await getSheetInfo(sheet_id)
      return text(info)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("sheets_create_spreadsheet", "Create a new Google Sheets spreadsheet with headers and optional initial rows", {
    title: z.string().describe("Spreadsheet title"),
    headers: z.array(z.string()).describe("Column header names (e.g. [\"name\", \"email\", \"company\"])"),
    rows: z.array(z.array(z.string())).optional().describe("Optional initial data rows"),
  }, async ({ title, headers, rows }) => {
    try {
      const spreadsheetId = await createSpreadsheet(title, headers, rows ?? [])
      return text({ created: true, spreadsheet_id: spreadsheetId, title, headers })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("sheets_read_rows", "Read all rows as objects (header-keyed). Optionally filter by column value.", {
    sheet_id: z.string().describe("Google Sheets spreadsheet ID"),
    range: z.string().optional().describe("Sheet range (default: Sheet1)"),
    filter_column: z.string().optional().describe("Column name to filter by"),
    filter_value: z.string().optional().describe("Value to match in filter_column"),
  }, async ({ sheet_id, range, filter_column, filter_value }) => {
    try {
      let rows = await readRows(sheet_id, range ?? "Sheet1")
      if (filter_column && filter_value) {
        const col = filter_column.trim().toLowerCase()
        const val = filter_value.trim().toLowerCase()
        rows = rows.filter(r => r.values[col]?.toLowerCase() === val)
      }
      return text(rows)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("sheets_read_range", "Read raw cell values from a specific range", {
    sheet_id: z.string().describe("Google Sheets spreadsheet ID"),
    range: z.string().describe("Range in A1 notation (e.g. Sheet1!A1:C10)"),
  }, async ({ sheet_id, range }) => {
    try {
      const data = await readRange(sheet_id, range)
      return text(data)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("sheets_update_cell", "Update a single cell value", {
    sheet_id: z.string().describe("Google Sheets spreadsheet ID"),
    range: z.string().describe("Cell in A1 notation (e.g. Sheet1!D5)"),
    value: z.string().describe("New cell value"),
    contact_name: z.string().optional().describe("Contact name if this is a CRM contact row update"),
    contact_email: z.string().optional().describe("Contact email if this is a CRM contact row update"),
  }, async ({ sheet_id, range, value, contact_name, contact_email }) => {
    try {
      await updateCell(sheet_id, range, value)
      const result: Record<string, unknown> = { updated: true, range, value }

      if (contact_name && contact_email) {
        const match = range.match(/^(.+?)!([A-Z]+)(\d+)$/)
        if (match) {
          const sheetName = match[1]
          const rowNumber = parseInt(match[3], 10)
          const ref = contactRef(sheet_id, sheetName, rowNumber)
          try {
            const outputId = await publishContactRowOutput({
              ref,
              name: contact_name,
              email: contact_email,
              spreadsheetId: sheet_id,
              sheetName,
              rowNumber,
              action: "Updated CRM contact",
            })
            if (outputId) result.output_id = outputId
          } catch {
            // non-fatal: output publishing should not block the tool
          }
        }
      }

      return text(result)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  server.tool("sheets_append_row", "Append a new row to a sheet", {
    sheet_id: z.string().describe("Google Sheets spreadsheet ID"),
    values: z.array(z.string()).describe("Array of cell values for the new row"),
    range: z.string().optional().describe("Sheet range (default: Sheet1)"),
  }, async ({ sheet_id, values, range }) => {
    try {
      const sheetName = range ?? "Sheet1"
      await appendRow(sheet_id, sheetName, values)
      const result: Record<string, unknown> = { appended: true, values }

      // Try to publish a contact output if this looks like a contacts sheet
      try {
        const info = await getSheetInfo(sheet_id)
        const headers = (info.headers ?? []).map((h: string) => h.trim().toLowerCase())
        const emailIdx = findEmailColumnIndex(headers)
        const nameIdx = findNameColumnIndex(headers)

        if (emailIdx >= 0 && emailIdx < values.length) {
          const email = values[emailIdx]
          const name = nameIdx >= 0 && nameIdx < values.length ? values[nameIdx] : ""
          const rows = await readRows(sheet_id, sheetName)
          const lastRow = rows[rows.length - 1]
          if (lastRow) {
            const ref = contactRef(sheet_id, sheetName, lastRow.rowNumber)
            const outputId = await publishContactRowOutput({
              ref,
              name: name || email,
              email,
              spreadsheetId: sheet_id,
              sheetName,
              rowNumber: lastRow.rowNumber,
              action: "Added CRM contact",
            })
            if (outputId) result.output_id = outputId
          }
        }
      } catch {
        // non-fatal
      }

      return text(result)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  return server
}

export function startMcpServer(port: number) {
  const transports = new Map<string, SSEServerTransport>()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)

    if (url.pathname === "/mcp/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }

    if (url.pathname === "/mcp/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/mcp/messages", res)
      transports.set(transport.sessionId, transport)
      const server = createMcpServer()
      await server.connect(transport)
      return
    }

    if (url.pathname === "/mcp/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId")
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(400)
        res.end("Unknown session")
        return
      }
      await transport.handlePostMessage(req, res)
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  httpServer.listen(port, () => {
    console.log(`[mcp] server listening on port ${port}`)
  })

  return httpServer
}
