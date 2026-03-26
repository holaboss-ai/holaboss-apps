import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createServer } from "node:http"
import { z } from "zod"

import { MODULE_CONFIG } from "../lib/types"
import { getSheetInfo, readRows, readRange, updateCell, appendRow } from "./google-api"

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true }
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
  }, async ({ sheet_id, range, value }) => {
    try {
      await updateCell(sheet_id, range, value)
      return text({ updated: true, range, value })
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
      await appendRow(sheet_id, range ?? "Sheet1", values)
      return text({ appended: true, values })
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  return server
}

export function startMcpServer(port: number) {
  const server = createMcpServer()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }

    if (url.pathname === "/mcp") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)
      await transport.handleRequest(req, res)
      return
    }

    // Legacy SSE support (backward compatible)
    if (url.pathname === "/mcp/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  httpServer.listen(port, () => {
    console.log(`[Sheets] MCP server listening on port ${port}`)
  })

  return httpServer
}
