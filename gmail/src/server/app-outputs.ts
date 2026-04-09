import type { DraftRecord } from "../lib/types"
import {
  buildAppResourcePresentation,
  syncAppResourceOutput,
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

function buildDraftCrmMetadata(
  draft: DraftRecord,
  crm?: { contactRowRef?: string | null },
): Record<string, unknown> {
  return {
    contact_key: normalizedContactKey(draft.to_email),
    primary_email: draft.to_email,
    ...(crm?.contactRowRef ? { contact_row_ref: crm.contactRowRef } : {}),
  }
}

/**
 * Exposed for tests and any callers that inspect the raw metadata envelope.
 * The shape is mirrored by `syncAppResourceOutput` when `syncDraftOutput`
 * delegates to the SDK, so both paths produce identical output.
 */
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
    crm: buildDraftCrmMetadata(draft, crm),
  }
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

function buildThreadCrmMetadata(
  input: ThreadOutputInput,
): Record<string, unknown> {
  const primaryEmail = (input.primaryEmail ?? "").trim()
  return {
    ...(primaryEmail
      ? {
          contact_key: normalizedContactKey(primaryEmail),
          primary_email: primaryEmail,
        }
      : {}),
    ...(input.contactRowRef
      ? { contact_row_ref: input.contactRowRef }
      : {}),
  }
}

/**
 * Exposed for tests and any callers that inspect the raw metadata envelope.
 * The shape is mirrored by `syncAppResourceOutput` when `syncThreadOutput`
 * delegates to the SDK, so both paths produce identical output.
 */
export function buildThreadOutputMetadata(
  input: ThreadOutputInput,
): Record<string, unknown> {
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
    crm: buildThreadCrmMetadata(input),
  }
}

export async function syncDraftOutput(
  draft: DraftRecord,
  crm?: { contactRowRef?: string | null },
  context?: HolabossTurnContext | null,
): Promise<string | null> {
  const { outputId } = await syncAppResourceOutput(context ?? null, {
    moduleId: "gmail",
    platform: "google",
    artifactType: "draft",
    existingOutputId: draft.output_id ?? null,
    status: draft.status,
    resource: {
      entityType: "draft",
      entityId: draft.id,
      title: buildDraftOutputTitle(draft),
      view: "drafts",
      path: draftRoutePath(draft.id),
    },
    extraMetadata: { crm: buildDraftCrmMetadata(draft, crm) },
  })
  return outputId
}

export async function syncThreadOutput(
  input: ThreadOutputInput,
): Promise<string | null> {
  const { outputId } = await syncAppResourceOutput(null, {
    moduleId: "gmail",
    platform: "google",
    outputType: "thread",
    existingOutputId: input.existingOutputId ?? null,
    status: "ready",
    resource: {
      entityType: "thread",
      entityId: input.threadId,
      title: buildThreadOutputTitle(input),
      view: "threads",
      path: threadRoutePath(input.threadId),
    },
    extraMetadata: { crm: buildThreadCrmMetadata(input) },
  })
  return outputId
}
