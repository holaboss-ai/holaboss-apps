import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer } from "node:http"
import { z } from "zod"

import { MODULE_CONFIG } from "../lib/types"
import {
  addSheet,
  appendRow,
  createSpreadsheet,
  deleteRow,
  getSheetInfo,
  listSpreadsheets,
  readRange,
  readRows,
  updateCell,
  updateRow,
} from "./google-api"
import { contactRef, publishContactRowOutput } from "./app-outputs"

// Tool descriptions follow ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md
type ErrorCode =
  | "not_found"
  | "invalid_state"
  | "validation_failed"
  | "not_connected"
  | "rate_limited"
  | "upstream_error"
  | "internal"

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function success<T extends Record<string, unknown>>(data: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data }
}

function errCode(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ code, message, ...extra }) }], isError: true as const }
}

function upstreamErr(e: unknown) {
  return errCode("upstream_error", e instanceof Error ? e.message : String(e))
}

// Output shapes
const SheetInfoShape = {
  title: z.string(),
  headers: z.array(z.string()),
  rowCount: z.number(),
}
const CreateSpreadsheetShape = {
  created: z.literal(true),
  spreadsheet_id: z.string(),
  title: z.string(),
  headers: z.array(z.string()),
}
const UpdateCellResultShape = {
  updated: z.literal(true),
  range: z.string(),
  value: z.string(),
  output_id: z.string().optional(),
}
const AppendRowResultShape = {
  appended: z.literal(true),
  values: z.array(z.string()),
  output_id: z.string().optional(),
}
const UpdateRowResultShape = {
  updated: z.literal(true),
  row_number: z.number(),
  values: z.record(z.string(), z.string()),
  output_id: z.string().optional(),
}
const DeleteRowResultShape = { deleted: z.literal(true), row_number: z.number() }
const AddSheetResultShape = {
  added: z.literal(true),
  sheet_id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
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

  server.registerTool(
    "sheets_get_info",
    {
      title: "Get sheet info",
      description: `Get the title, header row, and row count of a spreadsheet (Sheet1 by default).

When to use: before reading or writing data, learn the column names so you can address rows by header.
Returns: { title, headers: string[], rowCount }.`,
      inputSchema: {
        sheet_id: z.string().describe("Google Sheets spreadsheet id, the long string in the sheet URL after '/d/'."),
      },
      outputSchema: SheetInfoShape,
      annotations: {
        title: "Get sheet info",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sheet_id }) => {
      try {
        const info = await getSheetInfo(sheet_id)
        return success(info as unknown as Record<string, unknown>)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "sheets_create_spreadsheet",
    {
      title: "Create spreadsheet",
      description: `Create a brand-new Google Sheet with header row and optional initial data.

When to use: bootstrapping a new tracker (CRM contact list, content calendar, pipeline, etc.).
Returns: { created: true, spreadsheet_id, title, headers }. Use spreadsheet_id with other sheets_* tools.`,
      inputSchema: {
        title: z.string().describe("Spreadsheet title shown in Google Drive."),
        headers: z
          .array(z.string())
          .describe("Column header row, e.g. ['name', 'email', 'company', 'stage']."),
        rows: z
          .array(z.array(z.string()))
          .optional()
          .describe("Optional initial data rows, e.g. [['Alice', 'a@b.com', 'Acme', 'lead']]."),
      },
      outputSchema: CreateSpreadsheetShape,
      annotations: {
        title: "Create spreadsheet",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, headers, rows }) => {
      try {
        const spreadsheetId = await createSpreadsheet(title, headers, rows ?? [])
        return success({ created: true as const, spreadsheet_id: spreadsheetId, title, headers })
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "sheets_list_spreadsheets",
    {
      title: "List spreadsheets",
      description: `List the user's Google Sheets, optionally filtered by name.

When to use: the user references a sheet by name and you need its id; or a discovery question like "what sheets do I have?".
Returns: array of { id, name, modified_at }.`,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Substring to filter spreadsheet names (case-insensitive contains). Omit to list all."),
      },
      annotations: {
        title: "List spreadsheets",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      try {
        const sheets = await listSpreadsheets(query)
        return text(sheets)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "sheets_read_rows",
    {
      title: "Read rows as objects",
      description: `Read all data rows as objects keyed by header name. Supports server-side filtering by a column value (case-insensitive contains).

When to use: scan or search a sheet's contents.
Prerequisites: call sheets_get_info first if you don't already know the headers.
Returns: array of { rowNumber, values: { <header>: string } }. rowNumber is 1-indexed; data rows start at 2 (row 1 is the header).`,
      inputSchema: {
        sheet_id: z.string().describe("Google Sheets spreadsheet id."),
        range: z
          .string()
          .optional()
          .describe("Sheet tab name, e.g. 'Sheet1' or 'Contacts'. Default 'Sheet1'."),
        filter_column: z
          .string()
          .optional()
          .describe("Column header to filter by, e.g. 'email'. Case-insensitive."),
        filter_value: z
          .string()
          .optional()
          .describe("Value to match in filter_column (partial / contains). Both filter_column AND filter_value must be supplied to filter."),
      },
      annotations: {
        title: "Read rows as objects",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sheet_id, range, filter_column, filter_value }) => {
      try {
        let rows = await readRows(sheet_id, range ?? "Sheet1")
        if (filter_column && filter_value) {
          const col = filter_column.trim().toLowerCase()
          const val = filter_value.trim().toLowerCase()
          rows = rows.filter(r => r.values[col]?.toLowerCase().includes(val))
        }
        return text(rows)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "sheets_read_range",
    {
      title: "Read raw range",
      description: `Read raw cell values from an A1-notation range. Returns a 2D string array — no header keying.

When to use: reading a non-rectangular slice, a range that spans tabs, or when you don't want header inference.
Returns: 2D array of strings, e.g. [['Alice', 'a@b.com'], ['Bob', 'b@c.com']].`,
      inputSchema: {
        sheet_id: z.string().describe("Google Sheets spreadsheet id."),
        range: z
          .string()
          .describe("A1 notation range, e.g. 'Sheet1!A1:C10' or 'Contacts!B2:B'."),
      },
      annotations: {
        title: "Read raw range",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sheet_id, range }) => {
      try {
        const data = await readRange(sheet_id, range)
        return text(data)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "sheets_update_cell",
    {
      title: "Update cell",
      description: `Write a single cell value.

When to use: targeted edit — "set D5 to 'closed'".
Side effects: if BOTH contact_name and contact_email are passed AND the range is a single-cell A1 ref like 'Sheet1!D5', a CRM contact output is published in the Holaboss workspace, linked to that row.
Returns: { updated: true, range, value, output_id? }.`,
      inputSchema: {
        sheet_id: z.string().describe("Google Sheets spreadsheet id."),
        range: z.string().describe("Single-cell A1 notation, e.g. 'Sheet1!D5'."),
        value: z.string().describe("New cell value as a string. Use '' to clear."),
        contact_name: z
          .string()
          .optional()
          .describe("Contact name — pass with contact_email to publish a CRM output for the row containing this cell."),
        contact_email: z
          .string()
          .optional()
          .describe("Contact email — pass with contact_name to publish a CRM output for the row containing this cell."),
      },
      outputSchema: UpdateCellResultShape,
      annotations: {
        title: "Update cell",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sheet_id, range, value, contact_name, contact_email }) => {
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

        return success(result)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "sheets_append_row",
    {
      title: "Append row",
      description: `Append a row to the end of a sheet tab.

Side effects: if the sheet has an 'email'/'mail'/'e-mail' column AND the appended row contains an email, a CRM contact output is auto-published linking the new row to a Holaboss contact.
Returns: { appended: true, values, output_id? }.`,
      inputSchema: {
        sheet_id: z.string().describe("Google Sheets spreadsheet id."),
        values: z
          .array(z.string())
          .describe("Cell values for the new row in column order, e.g. ['Alice', 'a@b.com', 'Acme']."),
        range: z
          .string()
          .optional()
          .describe("Sheet tab name to append to, e.g. 'Sheet1' or 'Contacts'. Default 'Sheet1'."),
      },
      outputSchema: AppendRowResultShape,
      annotations: {
        title: "Append row",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sheet_id, values, range }) => {
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

        return success(result)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "sheets_update_row",
    {
      title: "Update row",
      description: `Replace columns in an existing row by row number, supplying { column_name: value } pairs.

Prerequisites: row_number from sheets_read_rows (each row in the result has a rowNumber field). First data row is 2 (row 1 is the header).
Side effects: if contact_name OR contact_email is passed, a CRM contact output is published linking to this row.
Returns: { updated: true, row_number, values, output_id? }.`,
      inputSchema: {
        sheet_id: z.string().describe("Google Sheets spreadsheet id."),
        row_number: z
          .number()
          .int()
          .min(2)
          .describe("Row number to update. First data row is 2 (row 1 is the header)."),
        values: z
          .record(z.string())
          .describe("Map of column header → new value, e.g. { stage: 'closed', notes: 'paid invoice' }."),
        range: z
          .string()
          .optional()
          .describe("Sheet tab name, e.g. 'Sheet1' or 'Contacts'. Default 'Sheet1'."),
        contact_name: z
          .string()
          .optional()
          .describe("Contact name — pass with contact_email to publish a CRM output for this row."),
        contact_email: z
          .string()
          .optional()
          .describe("Contact email — pass with contact_name to publish a CRM output for this row."),
      },
      outputSchema: UpdateRowResultShape,
      annotations: {
        title: "Update row",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sheet_id, row_number, values, range, contact_name, contact_email }) => {
      try {
        const sheetName = range ?? "Sheet1"
        const info = await getSheetInfo(sheet_id)
        const headers = info.headers ?? []
        await updateRow(sheet_id, row_number, headers.length, values, headers)
        const result: Record<string, unknown> = { updated: true, row_number, values }

        if (contact_name || contact_email) {
          const name = contact_name ?? ""
          const email = contact_email ?? ""
          if (name || email) {
            const ref = contactRef(sheet_id, sheetName, row_number)
            try {
              const outputId = await publishContactRowOutput({
                ref,
                name: name || email,
                email,
                spreadsheetId: sheet_id,
                sheetName,
                rowNumber: row_number,
                action: "Updated CRM contact",
              })
              if (outputId) result.output_id = outputId
            } catch {
              // non-fatal
            }
          }
        }

        return success(result)
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "sheets_delete_row",
    {
      title: "Delete row",
      description: `Delete a row by row number. All subsequent rows shift up by 1, so any cached row numbers become stale — re-read with sheets_read_rows after deleting.

Prerequisites: row_number from sheets_read_rows. First data row is 2.
Returns: { deleted: true, row_number }.`,
      inputSchema: {
        sheet_id: z.string().describe("Google Sheets spreadsheet id."),
        row_number: z
          .number()
          .int()
          .min(2)
          .describe("Row number to delete. First data row is 2 (row 1 is the header)."),
        range: z
          .string()
          .optional()
          .describe("Sheet tab name, e.g. 'Sheet1' or 'Contacts'. Default 'Sheet1'."),
      },
      outputSchema: DeleteRowResultShape,
      annotations: {
        title: "Delete row",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sheet_id, row_number, range }) => {
      try {
        await deleteRow(sheet_id, range ?? "Sheet1", row_number)
        return success({ deleted: true as const, row_number })
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

  server.registerTool(
    "sheets_add_sheet",
    {
      title: "Add sheet tab",
      description: `Add a new sheet (tab) to an existing spreadsheet.

When to use: organize data into multiple tabs within one spreadsheet — e.g. 'Contacts' and 'Companies' tabs in the same file.
Returns: { added: true, sheet_id, title, ... } where sheet_id is the new tab's internal id (not the spreadsheet id).`,
      inputSchema: {
        sheet_id: z.string().describe("Spreadsheet id (the file). NOT the tab id."),
        title: z.string().describe("Name for the new tab, e.g. 'Companies' or 'Q2 Pipeline'."),
      },
      outputSchema: AddSheetResultShape,
      annotations: {
        title: "Add sheet tab",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ sheet_id, title }) => {
      try {
        const result = await addSheet(sheet_id, title)
        return success({ added: true as const, ...(result as Record<string, unknown>) })
      } catch (e) {
        return upstreamErr(e)
      }
    },
  )

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
