import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import {
  apiGet,
  apiPatch,
  apiPost,
  contactDeepLink,
  dealDeepLink,
  deepLinkFor,
} from "./hubspot-client"
import { wrapTool } from "./audit"
import { isSyncEnabled, setSyncEnabled, syncCrm } from "./sync"
import type {
  HubspotError,
  HubspotRecord,
  Result,
  ToolSuccessMeta,
} from "../lib/types"

// -------------------- Portal id resolution (cached) --------------------
//
// The portal id is needed to construct deep links. It's stable per token,
// so we fetch once and cache. /account-info/v3/details (verified in Phase 0)
// returns `{ portalId: number, ... }` using just the Bearer token.

let _portalIdCache: string | null = null

interface AccountDetails {
  portalId?: number
}

async function getPortalId(): Promise<string | null> {
  if (_portalIdCache) return _portalIdCache
  const r = await apiGet<AccountDetails>("/account-info/v3/details")
  if (!r.ok) return null
  if (r.data?.portalId !== undefined) {
    _portalIdCache = String(r.data.portalId)
    return _portalIdCache
  }
  return null
}

export function resetPortalIdCacheForTests(): void {
  _portalIdCache = null
}

// -------------------- Constants --------------------
//
// Standard HubSpot association type ids (HUBSPOT_DEFINED category).
// These are the canonical "engagement → CRM record" type ids per HubSpot's
// public list of association types. They are stable across portals.
//
// Assumption (per Plan §10): the OAuth grant exposed via @holaboss/bridge
// includes the standard CRM scopes (crm.objects.{contacts,companies,deals}.{read,write},
// crm.schemas.{contacts,deals}.read, plus engagement scopes for notes/tasks).
const ASSOC = {
  noteToContact: 202,
  noteToCompany: 190,
  noteToDeal: 214,
  taskToContact: 204,
  taskToCompany: 192,
  taskToDeal: 216,
} as const

function noteAssocTypeId(parent: "contacts" | "companies" | "deals"): number {
  if (parent === "contacts") return ASSOC.noteToContact
  if (parent === "companies") return ASSOC.noteToCompany
  return ASSOC.noteToDeal
}
function taskAssocTypeId(parent: "contacts" | "companies" | "deals"): number {
  if (parent === "contacts") return ASSOC.taskToContact
  if (parent === "companies") return ASSOC.taskToCompany
  return ASSOC.taskToDeal
}

// -------------------- Common output shapes --------------------

const ToolSuccessMetaShape = {
  hubspot_object: z.string().optional(),
  hubspot_record_id: z.string().optional(),
  hubspot_deep_link: z.string().optional(),
  result_summary: z.string().optional(),
}

const RecordRefSchema = z.record(z.string(), z.unknown())

const ConnectionStatusShape = {
  connected: z.boolean(),
  portal_id: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  ...ToolSuccessMetaShape,
}

const SchemaPropertySchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  fieldType: z.string(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  is_required: z.boolean().optional(),
  is_calculated: z.boolean().optional(),
})
const DescribeSchemaShape = {
  object_type: z.string(),
  properties: z.array(SchemaPropertySchema),
  ...ToolSuccessMetaShape,
}

const SearchContactsShape = {
  contacts: z.array(RecordRefSchema),
  next_cursor: z.string().nullable(),
  ...ToolSuccessMetaShape,
}
const SearchCompaniesShape = {
  companies: z.array(RecordRefSchema),
  next_cursor: z.string().nullable(),
  ...ToolSuccessMetaShape,
}

const ContactOneShape = { contact: RecordRefSchema, ...ToolSuccessMetaShape }

const ContactIdShape = {
  ...ToolSuccessMetaShape,
  contact_id: z.string(),
  hubspot_deep_link: z.string(),
}
const DealIdShape = {
  ...ToolSuccessMetaShape,
  deal_id: z.string(),
  hubspot_deep_link: z.string(),
}
const DealStageShape = {
  ...ToolSuccessMetaShape,
  deal_id: z.string(),
  dealstage: z.string(),
  hubspot_deep_link: z.string(),
}

const PipelineStageSchema = z.object({
  stage_id: z.string(),
  label: z.string(),
  display_order: z.number(),
  probability: z.number().nullable(),
})
const PipelineSchema = z.object({
  pipeline_id: z.string(),
  label: z.string(),
  stages: z.array(PipelineStageSchema),
})
const PipelinesShape = {
  pipelines: z.array(PipelineSchema),
  ...ToolSuccessMetaShape,
}

const NoteIdShape = {
  ...ToolSuccessMetaShape,
  note_id: z.string(),
}
const TaskIdShape = {
  task_id: z.string(),
  ...ToolSuccessMetaShape,
}

// -------------------- Helpers --------------------

function normalizeContactRecord(raw: Record<string, unknown>): HubspotRecord {
  return {
    id: String(raw.id ?? ""),
    properties: (raw.properties as Record<string, unknown>) ?? {},
  }
}

const asText = (result: Result<unknown, HubspotError>) => {
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      structuredContent: result.data as Record<string, unknown>,
    }
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
    isError: true as const,
  }
}

// -------------------- 1. get_connection_status --------------------

export async function getConnectionStatusImpl(
  _input: Record<string, never>,
): Promise<Result<{ connected: boolean; portal_id?: string; scopes?: string[] } & ToolSuccessMeta, HubspotError>> {
  const r = await apiGet<AccountDetails>("/account-info/v3/details")
  if (r.ok) {
    const portalId = r.data?.portalId !== undefined ? String(r.data.portalId) : undefined
    if (portalId) _portalIdCache = portalId
    return {
      ok: true,
      data: {
        connected: true,
        portal_id: portalId,
        // Note: HubSpot does not return granted scopes via /account-info.
        // The OAuth introspect endpoint requires a client_secret we don't hold.
        // Scopes therefore remain `undefined` here; missing-scope errors surface
        // at the tool that needs them via 403 → "scope missing: ..." messages.
        result_summary: portalId ? `Connected to portal ${portalId}` : "Connected",
      },
    }
  }
  if (r.error.code === "not_connected") {
    return { ok: true, data: { connected: false, result_summary: "Not connected" } }
  }
  return r as unknown as Result<{ connected: boolean } & ToolSuccessMeta, HubspotError>
}

// -------------------- 2. describe_schema --------------------

export interface DescribeSchemaInput {
  object_type: "contacts" | "companies" | "deals" | "tickets"
}
export interface SchemaProperty {
  name: string
  label: string
  type: string
  fieldType: string
  options?: Array<{ label: string; value: string }>
  is_required?: boolean
  is_calculated?: boolean
}

export async function describeSchemaImpl(
  input: DescribeSchemaInput,
): Promise<Result<{ object_type: string; properties: SchemaProperty[] } & ToolSuccessMeta, HubspotError>> {
  const r = await apiGet<{ results: Array<Record<string, unknown>> }>(
    `/crm/v3/properties/${input.object_type}`,
  )
  if (!r.ok) return r
  const props: SchemaProperty[] = (r.data.results ?? []).map((p) => {
    const optsRaw = (p.options as Array<Record<string, unknown>> | undefined) ?? []
    const options = optsRaw.length > 0
      ? optsRaw.map((o) => ({ label: String(o.label ?? ""), value: String(o.value ?? "") }))
      : undefined
    return {
      name: String(p.name ?? ""),
      label: String(p.label ?? ""),
      type: String(p.type ?? ""),
      fieldType: String(p.fieldType ?? ""),
      ...(options ? { options } : {}),
      // HubSpot doesn't expose `is_required` directly on properties; use `formField` + `hidden`
      // as proxies if we want richer semantics. Default to false to keep payloads honest.
      is_required: false,
      is_calculated: Boolean(p.calculated),
    }
  })
  return {
    ok: true,
    data: {
      object_type: input.object_type,
      properties: props,
      result_summary: `Described ${props.length} ${input.object_type} properties`,
    },
  }
}

// -------------------- Search filters (shared by contacts + companies) --------------------

const SearchOperatorEnum = z.enum([
  "EQ",
  "NEQ",
  "LT",
  "LTE",
  "GT",
  "GTE",
  "BETWEEN",
  "IN",
  "NOT_IN",
  "HAS_PROPERTY",
  "NOT_HAS_PROPERTY",
  "CONTAINS_TOKEN",
  "NOT_CONTAINS_TOKEN",
])
type SearchOperator = z.infer<typeof SearchOperatorEnum>

interface SearchFilterInput {
  property: string
  operator: SearchOperator
  value?: unknown
  values?: unknown[]
}
interface SearchSortInput {
  property: string
  direction: "ASCENDING" | "DESCENDING"
}

interface HubspotFilter {
  propertyName: string
  operator: SearchOperator
  value?: string
  highValue?: string
  values?: string[]
}

/**
 * Translate the agent's SearchFilterInput into HubSpot's filter shape.
 *
 * Phase 0 verification: HubSpot's BETWEEN operator uses `value` + `highValue`
 * (NOT `values: [low, high]`). For BETWEEN we accept EITHER:
 *   - { operator: 'BETWEEN', values: [low, high] } — agent-friendly
 *   - { operator: 'BETWEEN', value: low, values: [high] } — fallback
 * and emit `{ value, highValue }` to HubSpot.
 *
 * IN / NOT_IN take `values: [...]`. EQ/NEQ/LT/etc. take a single `value`.
 * HAS_PROPERTY / NOT_HAS_PROPERTY take no value.
 */
function toHubspotFilter(f: SearchFilterInput): HubspotFilter {
  const base: HubspotFilter = { propertyName: f.property, operator: f.operator }
  if (f.operator === "BETWEEN") {
    if (Array.isArray(f.values) && f.values.length >= 2) {
      base.value = String(f.values[0])
      base.highValue = String(f.values[1])
    } else if (f.value !== undefined && Array.isArray(f.values) && f.values.length >= 1) {
      base.value = String(f.value)
      base.highValue = String(f.values[0])
    }
    return base
  }
  if (f.operator === "IN" || f.operator === "NOT_IN") {
    if (Array.isArray(f.values)) base.values = f.values.map((v) => String(v))
    return base
  }
  if (f.operator === "HAS_PROPERTY" || f.operator === "NOT_HAS_PROPERTY") {
    return base
  }
  if (f.value !== undefined) base.value = String(f.value)
  return base
}

interface HubspotSearchBody {
  filterGroups: Array<{ filters: HubspotFilter[] }>
  sorts?: Array<{ propertyName: string; direction: "ASCENDING" | "DESCENDING" }>
  query?: string
  properties?: string[]
  limit?: number
  after?: string
}

export function buildSearchBody(input: {
  query?: string
  filters?: SearchFilterInput[]
  sorts?: SearchSortInput[]
  properties?: string[]
  limit?: number
  after?: string
}): HubspotSearchBody {
  const body: HubspotSearchBody = {
    filterGroups:
      input.filters && input.filters.length > 0
        ? [{ filters: input.filters.map(toHubspotFilter) }]
        : [],
  }
  if (input.query) body.query = input.query
  if (input.properties && input.properties.length > 0) body.properties = input.properties
  if (input.sorts && input.sorts.length > 0) {
    body.sorts = input.sorts.map((s) => ({ propertyName: s.property, direction: s.direction }))
  }
  if (input.limit !== undefined) body.limit = input.limit
  if (input.after) body.after = input.after
  return body
}

interface HubspotSearchResponse {
  results: Array<Record<string, unknown>>
  paging?: { next?: { after?: string } }
}

// -------------------- 3. search_contacts --------------------

export interface SearchContactsInput {
  query?: string
  filters?: SearchFilterInput[]
  sorts?: SearchSortInput[]
  properties?: string[]
  limit?: number
  after?: string
}

export async function searchContactsImpl(
  input: SearchContactsInput,
): Promise<Result<{ contacts: HubspotRecord[]; next_cursor: string | null } & ToolSuccessMeta, HubspotError>> {
  const body = buildSearchBody({
    query: input.query,
    filters: input.filters,
    sorts: input.sorts,
    properties: input.properties,
    limit: input.limit,
    after: input.after,
  })
  const r = await apiPost<HubspotSearchResponse>("/crm/v3/objects/contacts/search", body)
  if (!r.ok) return r
  const contacts = (r.data.results ?? []).map(normalizeContactRecord)
  const next = r.data.paging?.next?.after ?? null
  return {
    ok: true,
    data: {
      contacts,
      next_cursor: next,
      hubspot_object: "contacts",
      result_summary: `Found ${contacts.length} contact(s)`,
    },
  }
}

// -------------------- 4. get_contact --------------------

export interface GetContactInput {
  contact_id: string
  properties?: string[]
}

export async function getContactImpl(
  input: GetContactInput,
): Promise<Result<{ contact: HubspotRecord } & ToolSuccessMeta, HubspotError>> {
  const params = new URLSearchParams()
  if (input.properties && input.properties.length > 0) {
    params.set("properties", input.properties.join(","))
  }
  const qs = params.toString()
  const path = qs
    ? `/crm/v3/objects/contacts/${encodeURIComponent(input.contact_id)}?${qs}`
    : `/crm/v3/objects/contacts/${encodeURIComponent(input.contact_id)}`
  const r = await apiGet<Record<string, unknown>>(path)
  if (!r.ok) return r
  const contact = normalizeContactRecord(r.data)
  const portalId = await getPortalId()
  return {
    ok: true,
    data: {
      contact,
      hubspot_object: "contacts",
      hubspot_record_id: contact.id,
      ...(portalId ? { hubspot_deep_link: contactDeepLink(portalId, contact.id) } : {}),
      result_summary: `Fetched contact ${contact.id}`,
    },
  }
}

// -------------------- 5. create_contact --------------------

interface AssociationInput {
  to_object_type: "companies" | "deals"
  to_object_id: string
  association_type_id?: number
}

export interface CreateContactInput {
  properties: Record<string, unknown>
  associations?: AssociationInput[]
}

// HubSpot association type ids from contact → other objects (HUBSPOT_DEFINED).
const CONTACT_TO_COMPANY_PRIMARY = 1
const CONTACT_TO_DEAL_PRIMARY = 4

function buildContactAssociations(
  associations: AssociationInput[] | undefined,
): Array<Record<string, unknown>> {
  if (!associations || associations.length === 0) return []
  return associations.map((a) => ({
    to: { id: a.to_object_id },
    types: [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId:
          a.association_type_id ??
          (a.to_object_type === "companies"
            ? CONTACT_TO_COMPANY_PRIMARY
            : CONTACT_TO_DEAL_PRIMARY),
      },
    ],
  }))
}

export async function createContactImpl(
  input: CreateContactInput,
): Promise<Result<{ contact_id: string; hubspot_deep_link: string } & ToolSuccessMeta, HubspotError>> {
  const body: Record<string, unknown> = { properties: input.properties }
  const assoc = buildContactAssociations(input.associations)
  if (assoc.length > 0) body.associations = assoc

  const r = await apiPost<{ id?: string }>("/crm/v3/objects/contacts", body)
  if (!r.ok) return r
  const id = String(r.data?.id ?? "")
  const portalId = await getPortalId()
  const link = portalId ? contactDeepLink(portalId, id) : `https://app.hubspot.com/contacts`
  return {
    ok: true,
    data: {
      contact_id: id,
      hubspot_deep_link: link,
      hubspot_object: "contacts",
      hubspot_record_id: id,
      result_summary: `Created contact ${id}`,
    },
  }
}

// -------------------- 6. update_contact --------------------

export interface UpdateContactInput {
  contact_id: string
  properties: Record<string, unknown>
}

export async function updateContactImpl(
  input: UpdateContactInput,
): Promise<Result<{ contact_id: string; hubspot_deep_link: string } & ToolSuccessMeta, HubspotError>> {
  const r = await apiPatch<{ id?: string }>(
    `/crm/v3/objects/contacts/${encodeURIComponent(input.contact_id)}`,
    { properties: input.properties },
  )
  if (!r.ok) return r
  const portalId = await getPortalId()
  const link = portalId
    ? contactDeepLink(portalId, input.contact_id)
    : `https://app.hubspot.com/contacts`
  return {
    ok: true,
    data: {
      contact_id: input.contact_id,
      hubspot_deep_link: link,
      hubspot_object: "contacts",
      hubspot_record_id: input.contact_id,
      result_summary: `Updated contact ${input.contact_id}`,
    },
  }
}

// -------------------- 7. search_companies --------------------

export interface SearchCompaniesInput extends SearchContactsInput {}

export async function searchCompaniesImpl(
  input: SearchCompaniesInput,
): Promise<Result<{ companies: HubspotRecord[]; next_cursor: string | null } & ToolSuccessMeta, HubspotError>> {
  const body = buildSearchBody({
    query: input.query,
    filters: input.filters,
    sorts: input.sorts,
    properties: input.properties,
    limit: input.limit,
    after: input.after,
  })
  const r = await apiPost<HubspotSearchResponse>("/crm/v3/objects/companies/search", body)
  if (!r.ok) return r
  const companies = (r.data.results ?? []).map(normalizeContactRecord)
  const next = r.data.paging?.next?.after ?? null
  return {
    ok: true,
    data: {
      companies,
      next_cursor: next,
      hubspot_object: "companies",
      result_summary: `Found ${companies.length} compan${companies.length === 1 ? "y" : "ies"}`,
    },
  }
}

// -------------------- 8. list_pipelines --------------------

export interface PipelineStage {
  stage_id: string
  label: string
  display_order: number
  probability: number | null
}
export interface Pipeline {
  pipeline_id: string
  label: string
  stages: PipelineStage[]
}

interface RawPipelineStage {
  id?: string
  label?: string
  displayOrder?: number
  metadata?: { probability?: string | number }
}
interface RawPipeline {
  id?: string
  label?: string
  stages?: RawPipelineStage[]
}

export async function listPipelinesImpl(
  _input: Record<string, never>,
): Promise<Result<{ pipelines: Pipeline[] } & ToolSuccessMeta, HubspotError>> {
  const r = await apiGet<{ results: RawPipeline[] }>("/crm/v3/pipelines/deals")
  if (!r.ok) return r
  const pipelines: Pipeline[] = (r.data.results ?? []).map((p) => ({
    pipeline_id: String(p.id ?? ""),
    label: String(p.label ?? ""),
    stages: (p.stages ?? []).map((s) => {
      const probRaw = s.metadata?.probability
      const probability =
        probRaw === undefined || probRaw === null || probRaw === ""
          ? null
          : Number(probRaw)
      return {
        stage_id: String(s.id ?? ""),
        label: String(s.label ?? ""),
        display_order: Number(s.displayOrder ?? 0),
        probability: Number.isFinite(probability as number) ? (probability as number) : null,
      }
    }),
  }))
  return {
    ok: true,
    data: {
      pipelines,
      result_summary: `Listed ${pipelines.length} deal pipeline(s)`,
    },
  }
}

// -------------------- 9. create_deal --------------------

interface DealAssociationInput {
  to_object_type: "contacts" | "companies"
  to_object_id: string
  association_type_id?: number
}
const DEAL_TO_CONTACT_PRIMARY = 3
const DEAL_TO_COMPANY_PRIMARY = 5

export interface CreateDealInput {
  properties: Record<string, unknown>
  associations?: DealAssociationInput[]
}

function buildDealAssociations(
  associations: DealAssociationInput[] | undefined,
): Array<Record<string, unknown>> {
  if (!associations || associations.length === 0) return []
  return associations.map((a) => ({
    to: { id: a.to_object_id },
    types: [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId:
          a.association_type_id ??
          (a.to_object_type === "contacts"
            ? DEAL_TO_CONTACT_PRIMARY
            : DEAL_TO_COMPANY_PRIMARY),
      },
    ],
  }))
}

export async function createDealImpl(
  input: CreateDealInput,
): Promise<Result<{ deal_id: string; hubspot_deep_link: string } & ToolSuccessMeta, HubspotError>> {
  const body: Record<string, unknown> = { properties: input.properties }
  const assoc = buildDealAssociations(input.associations)
  if (assoc.length > 0) body.associations = assoc

  const r = await apiPost<{ id?: string }>("/crm/v3/objects/deals", body)
  if (!r.ok) return r
  const id = String(r.data?.id ?? "")
  const portalId = await getPortalId()
  const link = portalId ? dealDeepLink(portalId, id) : `https://app.hubspot.com/contacts`
  return {
    ok: true,
    data: {
      deal_id: id,
      hubspot_deep_link: link,
      hubspot_object: "deals",
      hubspot_record_id: id,
      result_summary: `Created deal ${id}`,
    },
  }
}

// -------------------- 10. update_deal_stage --------------------

export interface UpdateDealStageInput {
  deal_id: string
  stage_id: string
}

export async function updateDealStageImpl(
  input: UpdateDealStageInput,
): Promise<Result<{ deal_id: string; dealstage: string; hubspot_deep_link: string } & ToolSuccessMeta, HubspotError>> {
  const r = await apiPatch<{ id?: string; properties?: Record<string, unknown> }>(
    `/crm/v3/objects/deals/${encodeURIComponent(input.deal_id)}`,
    { properties: { dealstage: input.stage_id } },
  )
  if (!r.ok) {
    // HubSpot returns 400/422 with a message like "Property values were not valid: dealstage..."
    // when the stage doesn't belong to the deal's pipeline. The hubspot-client mapping
    // already surfaces these as `validation_failed`, which is what we want.
    return r
  }
  const portalId = await getPortalId()
  const link = portalId
    ? dealDeepLink(portalId, input.deal_id)
    : `https://app.hubspot.com/contacts`
  return {
    ok: true,
    data: {
      deal_id: input.deal_id,
      dealstage: input.stage_id,
      hubspot_deep_link: link,
      hubspot_object: "deals",
      hubspot_record_id: input.deal_id,
      result_summary: `Moved deal ${input.deal_id} to stage ${input.stage_id}`,
    },
  }
}

// -------------------- 11. add_note --------------------

export interface AddNoteInput {
  parent_object: "contacts" | "companies" | "deals"
  parent_record_id: string
  content: string
  timestamp?: string
}

export async function addNoteImpl(
  input: AddNoteInput,
): Promise<Result<{ note_id: string; hubspot_deep_link?: string } & ToolSuccessMeta, HubspotError>> {
  const body = {
    properties: {
      hs_timestamp: input.timestamp ?? new Date().toISOString(),
      hs_note_body: input.content,
    },
    associations: [
      {
        to: { id: input.parent_record_id },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: noteAssocTypeId(input.parent_object),
          },
        ],
      },
    ],
  }
  const r = await apiPost<{ id?: string }>("/crm/v3/objects/notes", body)
  if (!r.ok) return r
  const id = String(r.data?.id ?? "")
  const portalId = await getPortalId()
  const link = portalId ? deepLinkFor(portalId, input.parent_object, input.parent_record_id) : undefined
  return {
    ok: true,
    data: {
      note_id: id,
      ...(link ? { hubspot_deep_link: link } : {}),
      hubspot_object: input.parent_object,
      hubspot_record_id: input.parent_record_id,
      result_summary: `Added note to ${input.parent_object}/${input.parent_record_id}`,
    },
  }
}

// -------------------- 12. create_task --------------------

export interface CreateTaskInput {
  subject: string
  body?: string
  due_date?: string
  priority?: "LOW" | "MEDIUM" | "HIGH"
  assignee_owner_id?: string
  linked_records?: Array<{
    object_type: "contacts" | "companies" | "deals"
    record_id: string
  }>
}

export async function createTaskImpl(
  input: CreateTaskInput,
): Promise<Result<{ task_id: string } & ToolSuccessMeta, HubspotError>> {
  const properties: Record<string, unknown> = {
    hs_timestamp: input.due_date ?? new Date().toISOString(),
    hs_task_subject: input.subject,
    hs_task_status: "NOT_STARTED",
    hs_task_type: "TODO",
  }
  if (input.body) properties.hs_task_body = input.body
  if (input.priority) properties.hs_task_priority = input.priority
  if (input.assignee_owner_id) properties.hubspot_owner_id = input.assignee_owner_id

  const associations = (input.linked_records ?? []).map((l) => ({
    to: { id: l.record_id },
    types: [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId: taskAssocTypeId(l.object_type),
      },
    ],
  }))

  const body: Record<string, unknown> = { properties }
  if (associations.length > 0) body.associations = associations

  const r = await apiPost<{ id?: string }>("/crm/v3/objects/tasks", body)
  if (!r.ok) return r
  const id = String(r.data?.id ?? "")
  return {
    ok: true,
    data: {
      task_id: id,
      result_summary: `Created task "${input.subject.slice(0, 40)}"`,
    },
  }
}

// -------------------- Sync (local mirror) --------------------

export interface SyncCrmInput {
  full?: boolean
  objects?: Array<"contacts" | "companies" | "deals">
}
export async function syncCrmImpl(
  input: SyncCrmInput,
): Promise<
  Result<
    {
      total_inserted: number
      total_updated: number
      rate_limited: boolean
      per_object: Array<{
        object_slug: string
        records_seen: number
        records_inserted: number
        records_updated: number
        errors_count: number
      }>
    } & ToolSuccessMeta,
    HubspotError
  >
> {
  try {
    const r = await syncCrm({ full: input.full, objects: input.objects })
    return {
      ok: true,
      data: {
        total_inserted: r.total_inserted,
        total_updated: r.total_updated,
        rate_limited: r.rate_limited,
        per_object: r.per_object.map((p) => ({
          object_slug: p.object_slug,
          records_seen: p.records_seen,
          records_inserted: p.records_inserted,
          records_updated: p.records_updated,
          errors_count: p.errors.length,
        })),
        result_summary: `Synced ${r.total_inserted + r.total_updated} record(s) across ${r.per_object.length} object(s)`,
      },
    }
  } catch (err) {
    return {
      ok: false,
      error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
    }
  }
}

export interface SetSyncEnabledInput { enabled: boolean }
export async function setSyncEnabledImpl(
  input: SetSyncEnabledInput,
): Promise<Result<{ enabled: boolean } & ToolSuccessMeta, HubspotError>> {
  setSyncEnabled(input.enabled)
  return {
    ok: true,
    data: {
      enabled: isSyncEnabled(),
      result_summary: input.enabled ? "HubSpot sync enabled" : "HubSpot sync disabled",
    },
  }
}

// -------------------- registerTools --------------------

export function registerTools(server: McpServer): void {
  const getConnectionStatus = wrapTool(
    "hubspot_get_connection_status",
    getConnectionStatusImpl,
  )
  const describeSchema = wrapTool("hubspot_describe_schema", describeSchemaImpl)
  const searchContacts = wrapTool("hubspot_search_contacts", searchContactsImpl)
  const getContact = wrapTool("hubspot_get_contact", getContactImpl)
  const createContact = wrapTool("hubspot_create_contact", createContactImpl)
  const updateContact = wrapTool("hubspot_update_contact", updateContactImpl)
  const searchCompanies = wrapTool("hubspot_search_companies", searchCompaniesImpl)
  const listPipelines = wrapTool("hubspot_list_pipelines", listPipelinesImpl)
  const createDeal = wrapTool("hubspot_create_deal", createDealImpl)
  const updateDealStage = wrapTool("hubspot_update_deal_stage", updateDealStageImpl)
  const addNote = wrapTool("hubspot_add_note", addNoteImpl)
  const createTask = wrapTool("hubspot_create_task", createTaskImpl)

  // 1. get_connection_status
  server.registerTool(
    "hubspot_get_connection_status",
    {
      title: "Check HubSpot connection",
      description: `Check whether HubSpot is connected for this workspace.

When to use: ALWAYS call this first if any hubspot_* tool returns { code: 'not_connected' }, or before suggesting HubSpot features for the first time.
Returns: { connected: true, portal_id } if linked, { connected: false } otherwise. portal_id is the HubSpot Hub id used in deep links. If a tool fails with "scope missing: <name>", the user must reconnect HubSpot from the Holaboss integrations page with that scope granted.`,
      inputSchema: {},
      outputSchema: ConnectionStatusShape,
      annotations: {
        title: "Check HubSpot connection",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => asText(await getConnectionStatus({})),
  )

  // 2. describe_schema
  server.registerTool(
    "hubspot_describe_schema",
    {
      title: "Describe HubSpot schema",
      description: `Describe properties (including custom fields) for a HubSpot CRM object type.

When to use: ALWAYS call this before hubspot_create_contact / hubspot_update_contact / hubspot_create_deal — every portal has different custom fields and required-property rules.
Returns: { object_type, properties: [{ name, label, type, fieldType, options?, is_required?, is_calculated? }] }. 'name' is the slug you pass into create/update; 'options' lists allowed values for enum properties.`,
      inputSchema: {
        object_type: z
          .enum(["contacts", "companies", "deals", "tickets"])
          .describe("Which CRM object's schema to fetch, e.g. 'contacts'."),
      },
      outputSchema: DescribeSchemaShape,
      annotations: {
        title: "Describe HubSpot schema",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await describeSchema(args)),
  )

  // 3. search_contacts
  server.registerTool(
    "hubspot_search_contacts",
    {
      title: "Search contacts",
      description: `Search HubSpot contacts using property filters and an optional free-text query.

When to use: any "find contacts where X" — filter by lifecyclestage, hubspot_owner_id, last_contacted_date, or custom properties.
When NOT to use: simple "get by id" — call hubspot_get_contact instead.
Prerequisites: call hubspot_describe_schema first to learn property slugs (especially custom fields).
Returns: { contacts: [{ id, properties }], next_cursor }. Pass next_cursor as 'after' to paginate. Default property set may be small — request what you need via 'properties'.
Errors: { code: 'rate_limited', retry_after } when HubSpot throttles (100 req / 10 sec on Standard tier). Do not auto-retry; back off or ask the user.`,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text query, e.g. 'alice' — searches default text properties (firstname, lastname, email, etc.).",
          ),
        filters: z
          .array(
            z.object({
              property: z
                .string()
                .describe(
                  "Property slug, e.g. 'lifecyclestage' or 'last_contacted_date'. From hubspot_describe_schema.",
                ),
              operator: SearchOperatorEnum.describe(
                "Comparison operator. EQ/NEQ/LT/LTE/GT/GTE take 'value'; IN/NOT_IN take 'values'; BETWEEN takes 'values: [low, high]'; HAS_PROPERTY/NOT_HAS_PROPERTY take neither.",
              ),
              value: z
                .unknown()
                .optional()
                .describe(
                  "Right-hand-side value for EQ/NEQ/LT/LTE/GT/GTE/CONTAINS_TOKEN/NOT_CONTAINS_TOKEN. Type depends on the property.",
                ),
              values: z
                .array(z.unknown())
                .optional()
                .describe(
                  "For IN / NOT_IN (list of values), or BETWEEN ([low, high] — exactly two entries).",
                ),
            }),
          )
          .optional()
          .describe(
            "AND-combined filters. To OR, call this tool multiple times and merge results client-side. Example: [{ property: 'lifecyclestage', operator: 'EQ', value: 'opportunity' }].",
          ),
        sorts: z
          .array(
            z.object({
              property: z
                .string()
                .describe("Property slug to sort by, e.g. 'lastmodifieddate'."),
              direction: z
                .enum(["ASCENDING", "DESCENDING"])
                .describe("Sort direction."),
            }),
          )
          .optional()
          .describe("Optional sort. Default: HubSpot's natural order."),
        properties: z
          .array(z.string())
          .optional()
          .describe(
            "Properties to return per contact, e.g. ['email','firstname','lifecyclestage']. Default: HubSpot's small default set.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max results per page, default 20, max 100."),
        after: z
          .string()
          .optional()
          .describe("Pagination cursor — pass the previous response's next_cursor."),
      },
      outputSchema: SearchContactsShape,
      annotations: {
        title: "Search contacts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await searchContacts(args)),
  )

  // 4. get_contact
  server.registerTool(
    "hubspot_get_contact",
    {
      title: "Get contact",
      description: `Fetch a single HubSpot contact by id with selected properties.

When to use: you have a contact_id from hubspot_search_contacts and want the full record.
Prerequisites: contact_id from hubspot_search_contacts.
Returns: { contact: { id, properties } }. By default HubSpot returns its small default property set; pass 'properties' to request more (especially custom fields).`,
      inputSchema: {
        contact_id: z
          .string()
          .describe("HubSpot contact id (the numeric id, e.g. '12345'). From hubspot_search_contacts."),
        properties: z
          .array(z.string())
          .optional()
          .describe(
            "Property slugs to include, e.g. ['email','firstname','lifecyclestage','company']. Slugs from hubspot_describe_schema.",
          ),
      },
      outputSchema: ContactOneShape,
      annotations: {
        title: "Get contact",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await getContact(args)),
  )

  // 5. create_contact
  server.registerTool(
    "hubspot_create_contact",
    {
      title: "Create contact",
      description: `Create a new contact in HubSpot, optionally linked to existing companies or deals.

When to use: after hubspot_search_contacts confirms the contact does not already exist (HubSpot dedupes on email by default — passing an existing email errors).
Prerequisites: call hubspot_describe_schema (object_type: 'contacts') to learn required and custom property slugs.
Returns: { contact_id, hubspot_deep_link }.
Errors: { code: 'validation_failed' } if a required property is missing or a value violates an enum/format constraint — the message identifies the offending property.`,
      inputSchema: {
        properties: z
          .record(z.string(), z.unknown())
          .describe(
            "Map of property_slug → value, e.g. { email: 'a@b.com', firstname: 'Alice', lastname: 'Smith', lifecyclestage: 'lead' }. Slugs come from hubspot_describe_schema.",
          ),
        associations: z
          .array(
            z.object({
              to_object_type: z
                .enum(["companies", "deals"])
                .describe("Type of the existing record to link, 'companies' or 'deals'."),
              to_object_id: z
                .string()
                .describe("HubSpot record id of the existing company/deal to link."),
              association_type_id: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                  "Numeric HubSpot association type id (HUBSPOT_DEFINED). Defaults to the primary type (1 for contact→company, 4 for contact→deal).",
                ),
            }),
          )
          .optional()
          .describe(
            "Optionally link the new contact to existing companies or deals at create time, e.g. [{ to_object_type: 'companies', to_object_id: '6789' }].",
          ),
      },
      outputSchema: ContactIdShape,
      annotations: {
        title: "Create contact",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => asText(await createContact(args)),
  )

  // 6. update_contact
  server.registerTool(
    "hubspot_update_contact",
    {
      title: "Update contact",
      description: `Patch named properties on an existing HubSpot contact. Re-applying the same property map is a no-op (idempotent).

When to use: changing a contact's lifecycle_stage, owner, custom field, etc.
Prerequisites: contact_id from hubspot_search_contacts; property slugs from hubspot_describe_schema.
Returns: { contact_id, hubspot_deep_link }.
Errors: { code: 'not_found' } if contact_id doesn't exist; { code: 'validation_failed' } on enum/format violations.`,
      inputSchema: {
        contact_id: z
          .string()
          .describe("HubSpot contact id (from hubspot_search_contacts)."),
        properties: z
          .record(z.string(), z.unknown())
          .describe(
            "Map of property_slug → new value, e.g. { lifecyclestage: 'opportunity' }. Only listed slugs are modified; others are preserved.",
          ),
      },
      outputSchema: ContactIdShape,
      annotations: {
        title: "Update contact",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await updateContact(args)),
  )

  // 7. search_companies
  server.registerTool(
    "hubspot_search_companies",
    {
      title: "Search companies",
      description: `Search HubSpot companies using property filters and an optional free-text query.

When to use: "find companies where X" — filter by domain, industry, hubspot_owner_id, or any custom property.
When NOT to use: looking up a single company you already have an id for — call HubSpot's UI directly or hubspot_get_contact's associations field on a known contact.
Prerequisites: call hubspot_describe_schema (object_type: 'companies') to learn property slugs.
Returns: { companies: [{ id, properties }], next_cursor }. Filter shape mirrors hubspot_search_contacts.`,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free-text query, e.g. 'acme' — searches name and domain by default."),
        filters: z
          .array(
            z.object({
              property: z
                .string()
                .describe("Property slug, e.g. 'domain' or 'industry'. From hubspot_describe_schema."),
              operator: SearchOperatorEnum.describe(
                "Comparison operator. See hubspot_search_contacts for the operator semantics.",
              ),
              value: z.unknown().optional().describe("Right-hand-side value for single-value operators."),
              values: z
                .array(z.unknown())
                .optional()
                .describe("For IN / NOT_IN (list), or BETWEEN ([low, high])."),
            }),
          )
          .optional()
          .describe("AND-combined filters."),
        sorts: z
          .array(
            z.object({
              property: z.string().describe("Property slug to sort by."),
              direction: z.enum(["ASCENDING", "DESCENDING"]).describe("Sort direction."),
            }),
          )
          .optional(),
        properties: z
          .array(z.string())
          .optional()
          .describe("Properties to return per company, e.g. ['name','domain','industry']."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max results per page, default 20, max 100."),
        after: z
          .string()
          .optional()
          .describe("Pagination cursor from previous response's next_cursor."),
      },
      outputSchema: SearchCompaniesShape,
      annotations: {
        title: "Search companies",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await searchCompanies(args)),
  )

  // 8. list_pipelines
  server.registerTool(
    "hubspot_list_pipelines",
    {
      title: "List deal pipelines",
      description: `List all deal pipelines in this portal, with their stages.

When to use: ALWAYS call before hubspot_create_deal or hubspot_update_deal_stage — pipeline_id and stage_id are portal-specific (different per HubSpot account) and required by those tools.
Returns: { pipelines: [{ pipeline_id, label, stages: [{ stage_id, label, display_order, probability }] }] }. probability is HubSpot's deal-stage win probability (0..1) when set, otherwise null.`,
      inputSchema: {},
      outputSchema: PipelinesShape,
      annotations: {
        title: "List deal pipelines",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => asText(await listPipelines({})),
  )

  // 9. create_deal
  server.registerTool(
    "hubspot_create_deal",
    {
      title: "Create deal",
      description: `Create a new HubSpot deal, optionally linked to contacts and a buyer company.

When to use: after qualifying — log a new opportunity into a pipeline + stage.
Prerequisites: pipeline_id and stage_id from hubspot_list_pipelines; any required custom-property slugs from hubspot_describe_schema (object_type: 'deals').
Returns: { deal_id, hubspot_deep_link }.
Errors: { code: 'validation_failed' } if dealstage doesn't belong to the given pipeline, or a required property is missing.`,
      inputSchema: {
        properties: z
          .record(z.string(), z.unknown())
          .describe(
            "Map of property_slug → value. dealname, dealstage, and pipeline are typically required, e.g. { dealname: 'Acme Q2', amount: 50000, dealstage: '<stage_id>', pipeline: '<pipeline_id>' }. Stage and pipeline ids come from hubspot_list_pipelines.",
          ),
        associations: z
          .array(
            z.object({
              to_object_type: z
                .enum(["contacts", "companies"])
                .describe("Type of the existing record to link, 'contacts' or 'companies'."),
              to_object_id: z
                .string()
                .describe("HubSpot record id of the existing contact/company."),
              association_type_id: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                  "Numeric HubSpot association type id (HUBSPOT_DEFINED). Defaults to the primary type (3 for deal→contact, 5 for deal→company).",
                ),
            }),
          )
          .optional()
          .describe(
            "Link the new deal to existing contacts and the buyer company, e.g. [{ to_object_type: 'companies', to_object_id: '6789' }].",
          ),
      },
      outputSchema: DealIdShape,
      annotations: {
        title: "Create deal",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => asText(await createDeal(args)),
  )

  // 10. update_deal_stage
  server.registerTool(
    "hubspot_update_deal_stage",
    {
      title: "Update deal stage",
      description: `Move a deal to a different stage in its pipeline. Re-applying the same stage is a no-op (idempotent).

When to use: progressing a deal — "move Acme to Proposal" — by setting its dealstage property.
When NOT to use: editing arbitrary deal fields (use HubSpot's UI; no generic update_deal in v1).
Prerequisites: deal_id (from a search or earlier tool); stage_id from hubspot_list_pipelines.
Returns: { deal_id, dealstage, hubspot_deep_link }.
Errors: { code: 'validation_failed' } if stage_id does not belong to the deal's pipeline; { code: 'not_found' } if deal_id doesn't exist.`,
      inputSchema: {
        deal_id: z
          .string()
          .describe("HubSpot deal id (numeric, e.g. '987654')."),
        stage_id: z
          .string()
          .describe("Target stage id from hubspot_list_pipelines, e.g. 'appointmentscheduled'."),
      },
      outputSchema: DealStageShape,
      annotations: {
        title: "Update deal stage",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await updateDealStage(args)),
  )

  // 11. add_note
  server.registerTool(
    "hubspot_add_note",
    {
      title: "Add note",
      description: `Attach a plaintext note (a HubSpot 'note' engagement) to a contact, company, or deal. The note appears in the record's activity timeline.

When to use: log meeting summaries, follow-up details, or any free-form context against a CRM record.
When NOT to use: action items with deadlines — use hubspot_create_task instead.
Prerequisites: parent_record_id from a search tool (hubspot_search_contacts / hubspot_search_companies, or a deal id from another lookup).
Returns: { note_id, hubspot_deep_link } where hubspot_deep_link points at the parent record (HubSpot doesn't expose direct note URLs).`,
      inputSchema: {
        parent_object: z
          .enum(["contacts", "companies", "deals"])
          .describe("Type of the record the note is attached to."),
        parent_record_id: z
          .string()
          .describe(
            "HubSpot record id (contact/company/deal) to attach the note to, from a search tool.",
          ),
        content: z
          .string()
          .describe(
            "Note body in plaintext. HubSpot renders it in the activity timeline as text (no Markdown). Max 65,536 chars.",
          ),
        timestamp: z
          .string()
          .optional()
          .describe(
            "ISO 8601 with timezone, e.g. '2026-04-26T15:00:00Z' — when the activity happened. Default: now.",
          ),
      },
      outputSchema: NoteIdShape,
      annotations: {
        title: "Add note",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => asText(await addNote(args)),
  )

  // 12. create_task
  server.registerTool(
    "hubspot_create_task",
    {
      title: "Create task",
      description: `Create a HubSpot task (a to-do engagement) optionally linked to contacts, companies, and/or deals.

When to use: capture an action item — "follow up with Alice next Tuesday" — that needs to surface in someone's task list.
When NOT to use: free-form notes without a deadline — use hubspot_add_note.
Returns: { task_id }.`,
      inputSchema: {
        subject: z
          .string()
          .describe("Task title, e.g. 'Send Q2 proposal to Alice'."),
        body: z
          .string()
          .optional()
          .describe("Task description / longer notes (plaintext)."),
        due_date: z
          .string()
          .optional()
          .describe(
            "ISO 8601 deadline with explicit timezone, e.g. '2026-04-30T17:00:00Z' or '2026-04-30T17:00:00-05:00'. Default: now.",
          ),
        priority: z
          .enum(["LOW", "MEDIUM", "HIGH"])
          .optional()
          .describe("Task priority. Default: HubSpot's default (typically MEDIUM)."),
        assignee_owner_id: z
          .string()
          .optional()
          .describe(
            "HubSpot owner id to assign (numeric, e.g. '14240720'). Omit to leave unassigned. Owner ids come from hubspot's owners API (not exposed as a tool here — the user can find theirs in HubSpot Settings).",
          ),
        linked_records: z
          .array(
            z.object({
              object_type: z
                .enum(["contacts", "companies", "deals"])
                .describe("Type of the record to link."),
              record_id: z.string().describe("HubSpot record id of that contact/company/deal."),
            }),
          )
          .optional()
          .describe(
            "Records to link this task to, e.g. [{ object_type: 'contacts', record_id: '101' }, { object_type: 'deals', record_id: '202' }].",
          ),
      },
      outputSchema: TaskIdShape,
      annotations: {
        title: "Create task",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => asText(await createTask(args)),
  )

  const syncCrmTool = wrapTool("hubspot_sync_crm", syncCrmImpl)
  const setSyncEnabledTool = wrapTool("hubspot_set_sync_enabled", setSyncEnabledImpl)

  const SyncObjectShape = z.object({
    object_slug: z.string(),
    records_seen: z.number(),
    records_inserted: z.number(),
    records_updated: z.number(),
    errors_count: z.number(),
  })
  const SyncCrmShape = {
    total_inserted: z.number(),
    total_updated: z.number(),
    rate_limited: z.boolean(),
    per_object: z.array(SyncObjectShape),
    ...ToolSuccessMetaShape,
  }
  const SetSyncEnabledShape = { enabled: z.boolean(), ...ToolSuccessMetaShape }

  server.registerTool(
    "hubspot_sync_crm",
    {
      title: "Sync HubSpot CRM",
      description: `Pull records from HubSpot's standard objects (contacts, companies, deals) into the local mirror tables (hubspot_contacts, hubspot_companies, hubspot_deals). Runs automatically every 30 minutes; full reconciliation runs daily. Use this tool to force an immediate refresh.

When to use: the user asks "sync my CRM now", or after creating/updating records via hubspot_create_contact / hubspot_update_contact and you want the mirror to reflect them before answering downstream questions.
Default mode (full=false): incremental — pulls records modified since last sync. Misses deletions.
Full mode (full=true): paginates everything (capped at 5000 per object). Detects deletions but more expensive.
Returns: { total_inserted, total_updated, rate_limited, per_object: [{ object_slug, records_seen, records_inserted, records_updated, errors_count }] }.`,
      inputSchema: {
        full: z
          .boolean()
          .optional()
          .describe("If true, paginate everything (capped at 5000 per object). Default false = incremental since last sync."),
        objects: z
          .array(z.enum(["contacts", "companies", "deals"]))
          .optional()
          .describe("Restrict to a subset of standard objects. Default: all three."),
      },
      outputSchema: SyncCrmShape,
      annotations: {
        title: "Sync HubSpot CRM",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await syncCrmTool(args)),
  )

  server.registerTool(
    "hubspot_set_sync_enabled",
    {
      title: "Enable or disable HubSpot sync",
      description: `Turn the 30-minute auto-sync of HubSpot records on or off. The mirror tables still serve stale reads when disabled.

When to use: the user explicitly asks to pause / resume CRM syncing.
Returns: { enabled, result_summary }.`,
      inputSchema: {
        enabled: z.boolean().describe("true to enable auto-sync; false to disable."),
      },
      outputSchema: SetSyncEnabledShape,
      annotations: {
        title: "Set HubSpot sync enabled",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => asText(await setSyncEnabledTool(args)),
  )
}
