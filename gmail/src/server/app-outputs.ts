import type { DraftRecord } from "../lib/types"
import {
  buildAppResourcePresentation,
  createAppOutput,
  updateAppOutput,
} from "./holaboss-bridge"

function normalizedContactKey(email: string): string {
  return email.trim().toLowerCase()
}

export function draftRoutePath(draftId: string): string {
  return `/drafts/${encodeURIComponent(draftId)}`
}

export function buildDraftOutputTitle(draft: DraftRecord): string {
  const subject = (draft.subject ?? "").trim()
  return subject || `Draft to ${draft.to_email}`
}

export function buildDraftOutputMetadata(
  draft: DraftRecord,
  crm?: { contactRowRef?: string | null },
): Record<string, unknown> {
  return {
    source_kind: "application",
    presentation: buildAppResourcePresentation({
      view: "drafts",
      path: draftRoutePath(draft.id),
    }),
    resource: {
      entity_type: "draft",
      entity_id: draft.id,
      label: buildDraftOutputTitle(draft),
    },
    crm: {
      contact_key: normalizedContactKey(draft.to_email),
      primary_email: draft.to_email,
      ...(crm?.contactRowRef ? { contact_row_ref: crm.contactRowRef } : {}),
    },
  }
}

export async function syncDraftOutput(
  draft: DraftRecord,
  crm?: { contactRowRef?: string | null },
) {
  const title = buildDraftOutputTitle(draft)
  const metadata = buildDraftOutputMetadata(draft, crm)

  if (draft.output_id) {
    await updateAppOutput(draft.output_id, {
      title,
      status: draft.status,
      moduleResourceId: draft.id,
      metadata,
    })
    return draft.output_id
  }

  const output = await createAppOutput({
    outputType: "draft",
    title,
    moduleId: "gmail",
    moduleResourceId: draft.id,
    platform: "google",
    status: draft.status,
    metadata,
  })

  return output?.id ?? null
}
