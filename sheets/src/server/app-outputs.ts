import {
  buildAppResourcePresentation,
  createAppOutput,
  updateAppOutput,
} from "./holaboss-bridge"

export function contactRef(spreadsheetId: string, sheetName: string, rowNumber: number): string {
  return `${spreadsheetId}:${sheetName}:${rowNumber}`
}

export function contactRoutePath(ref: string): string {
  return `/contacts/${encodeURIComponent(ref)}`
}

export function buildContactRowOutputTitle(name: string, action: string): string {
  const trimmed = name.trim()
  return trimmed ? `${action}: ${trimmed}` : `${action}: contact row`
}

export function buildContactRowOutputMetadata(params: {
  ref: string
  name: string
  email?: string | null
  spreadsheetId: string
  sheetName: string
  rowNumber: number
}): Record<string, unknown> {
  return {
    source_kind: "application",
    presentation: buildAppResourcePresentation({
      view: "contacts",
      path: contactRoutePath(params.ref),
    }),
    resource: {
      entity_type: "contact_row",
      entity_id: params.ref,
      label: params.name.trim() || "Contact row",
    },
    crm: {
      contact_key: params.email ? params.email.trim().toLowerCase() : null,
      contact_row_ref: {
        spreadsheet_id: params.spreadsheetId,
        sheet_name: params.sheetName,
        row_number: params.rowNumber,
      },
    },
  }
}

export async function publishContactRowOutput(params: {
  ref: string
  name: string
  email?: string | null
  spreadsheetId: string
  sheetName: string
  rowNumber: number
  action: string
  existingOutputId?: string | null
}): Promise<string | null> {
  const title = buildContactRowOutputTitle(params.name, params.action)
  const metadata = buildContactRowOutputMetadata(params)

  if (params.existingOutputId) {
    await updateAppOutput(params.existingOutputId, {
      title,
      status: "updated",
      moduleResourceId: params.ref,
      metadata,
    })
    return params.existingOutputId
  }

  const output = await createAppOutput({
    outputType: "contact_row",
    title,
    moduleId: "sheets",
    moduleResourceId: params.ref,
    platform: "google",
    metadata,
  })

  return output?.id ?? null
}
