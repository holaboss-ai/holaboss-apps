import type { DraftRecord } from "../lib/types"
import {
  buildAppResourcePresentation,
  createAppOutput,
  publishSessionArtifact,
  updateAppOutput,
  type HolabossTurnContext,
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

export interface ThreadOutputInput {
  threadId: string
  subject?: string | null
  primaryEmail?: string | null
  contactRowRef?: string | null
  existingOutputId?: string | null
}

export function threadRoutePath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}`
}

export function buildThreadOutputTitle(input: ThreadOutputInput): string {
  const subject = (input.subject ?? "").trim()
  const primaryEmail = (input.primaryEmail ?? "").trim()
  if (subject) {
    return subject
  }
  if (primaryEmail) {
    return `Thread with ${primaryEmail}`
  }
  return `Thread ${input.threadId}`
}

export function buildThreadOutputMetadata(
  input: ThreadOutputInput,
): Record<string, unknown> {
  const primaryEmail = (input.primaryEmail ?? "").trim()
  return {
    source_kind: "application",
    presentation: buildAppResourcePresentation({
      view: "threads",
      path: threadRoutePath(input.threadId),
    }),
    resource: {
      entity_type: "thread",
      entity_id: input.threadId,
      label: buildThreadOutputTitle(input),
    },
    crm: {
      ...(primaryEmail
        ? {
            contact_key: normalizedContactKey(primaryEmail),
            primary_email: primaryEmail,
          }
        : {}),
      ...(input.contactRowRef
        ? {
            contact_row_ref: input.contactRowRef,
          }
        : {}),
    },
  }
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
  context?: HolabossTurnContext | null,
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

  if (!context) {
    return null
  }

  const artifact = await publishSessionArtifact(context, {
    artifactType: "draft",
    externalId: draft.id,
    title,
    moduleId: "gmail",
    moduleResourceId: draft.id,
    platform: "google",
    metadata,
  })

  return artifact?.output_id ?? null
}

export async function syncThreadOutput(input: ThreadOutputInput) {
  const title = buildThreadOutputTitle(input)
  const metadata = buildThreadOutputMetadata(input)

  if (input.existingOutputId) {
    await updateAppOutput(input.existingOutputId, {
      title,
      status: "ready",
      moduleResourceId: input.threadId,
      metadata,
    })
    return input.existingOutputId
  }

  const output = await createAppOutput({
    outputType: "thread",
    title,
    moduleId: "gmail",
    moduleResourceId: input.threadId,
    platform: "google",
    status: "ready",
    metadata,
  })

  return output?.id ?? null
}
