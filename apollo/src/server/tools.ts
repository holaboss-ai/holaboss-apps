import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { apiGet, apiPost } from "./apollo-client"
import { wrapTool } from "./audit"
import type {
  ApolloError,
  EmailEvent,
  OrganizationSummary,
  PaginationSummary,
  PersonSummary,
  Result,
  SequenceSummary,
  ToolSuccessMeta,
} from "../lib/types"

const APOLLO_APP_BASE = "https://app.apollo.io"

function personDeepLink(id: string) {
  return `${APOLLO_APP_BASE}/people/${id}`
}
function organizationDeepLink(id: string) {
  return `${APOLLO_APP_BASE}/organizations/${id}`
}
function sequenceDeepLink(id: string) {
  return `${APOLLO_APP_BASE}/sequences/${id}`
}

function s(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === "string") return v
  return String(v)
}

function n(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === "number" && Number.isFinite(v)) return v
  const parsed = Number(v)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizePerson(raw: Record<string, unknown>): PersonSummary {
  const org = (raw.organization as Record<string, unknown> | undefined) ?? undefined
  const fallbackName = [s(raw.first_name), s(raw.last_name)].filter(Boolean).join(" ").trim()
  const name = s(raw.name) ?? (fallbackName || null)
  return {
    id: s(raw.id) ?? "",
    name: name || null,
    first_name: s(raw.first_name),
    last_name: s(raw.last_name),
    title: s(raw.title),
    email: s(raw.email),
    linkedin_url: s(raw.linkedin_url),
    city: s(raw.city),
    state: s(raw.state),
    country: s(raw.country),
    organization: org
      ? {
          id: s(org.id),
          name: s(org.name),
          domain: s(org.primary_domain) ?? s(org.website_url) ?? s(org.domain),
        }
      : null,
  }
}

function normalizeOrganization(raw: Record<string, unknown>): OrganizationSummary {
  const tech = Array.isArray(raw.technology_names)
    ? (raw.technology_names as unknown[]).map((t) => s(t)).filter((x): x is string => Boolean(x))
    : Array.isArray(raw.current_technologies)
      ? (raw.current_technologies as Array<Record<string, unknown>>).map((t) => s(t.name)).filter(
          (x): x is string => Boolean(x),
        )
      : []
  return {
    id: s(raw.id) ?? "",
    name: s(raw.name),
    domain: s(raw.primary_domain) ?? s(raw.website_url) ?? s(raw.domain),
    website_url: s(raw.website_url),
    industry: s(raw.industry),
    estimated_num_employees: n(raw.estimated_num_employees),
    founded_year: n(raw.founded_year),
    city: s(raw.city),
    state: s(raw.state),
    country: s(raw.country),
    technology_names: tech,
  }
}

function normalizeSequence(raw: Record<string, unknown>): SequenceSummary {
  const stepsArr = Array.isArray(raw.emailer_steps) ? (raw.emailer_steps as unknown[]).length : null
  return {
    id: s(raw.id) ?? "",
    name: s(raw.name) ?? "(unnamed sequence)",
    active: Boolean(raw.active),
    archived: Boolean(raw.archived),
    num_steps: n(raw.num_steps) ?? stepsArr ?? 0,
    created_at: s(raw.created_at),
  }
}

function normalizeEmail(raw: Record<string, unknown>): EmailEvent {
  return {
    id: s(raw.id) ?? "",
    contact_id: s(raw.contact_id),
    emailer_campaign_id: s(raw.emailer_campaign_id),
    subject: s(raw.subject),
    status: s(raw.status),
    sent_at: s(raw.sent_at),
    opened_at: s(raw.opened_at),
    replied_at: s(raw.replied_at),
    bounced_at: s(raw.bounced_at),
    clicked_at: s(raw.clicked_at),
  }
}

function normalizePagination(raw: unknown): PaginationSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  return {
    page: n(r.page) ?? 1,
    per_page: n(r.per_page) ?? 0,
    total_entries: n(r.total_entries),
    total_pages: n(r.total_pages),
  }
}

// ---- Connection status ----

export interface GetConnectionStatusInput {}

export async function getConnectionStatusImpl(
  _input: GetConnectionStatusInput,
): Promise<
  Result<
    {
      connected: boolean
      user_email?: string
      team_name?: string
      is_master_key?: boolean
    } & ToolSuccessMeta,
    ApolloError
  >
> {
  const r = await apiGet<{
    is_logged_in?: boolean
    is_master_key?: boolean
    user?: { email?: string }
    team?: { name?: string }
  }>("/auth/health")
  if (r.ok) {
    return {
      ok: true,
      data: {
        connected: Boolean(r.data?.is_logged_in ?? true),
        user_email: r.data?.user?.email,
        team_name: r.data?.team?.name,
        is_master_key: r.data?.is_master_key,
        result_summary: "Apollo connection verified",
      },
    }
  }
  if (r.error.code === "not_connected") {
    return { ok: true, data: { connected: false, result_summary: "Apollo not connected" } }
  }
  return r as unknown as Result<{ connected: boolean } & ToolSuccessMeta, ApolloError>
}

// ---- Search people ----

export interface SearchPeopleInput {
  q_keywords?: string
  person_titles?: string[]
  person_seniorities?: string[]
  organization_domains?: string[]
  person_locations?: string[]
  organization_num_employees_ranges?: string[]
  page?: number
  per_page?: number
}

export async function searchPeopleImpl(
  input: SearchPeopleInput,
): Promise<
  Result<
    { people: PersonSummary[]; pagination?: PaginationSummary } & ToolSuccessMeta,
    ApolloError
  >
> {
  const body: Record<string, unknown> = {}
  if (input.q_keywords !== undefined) body.q_keywords = input.q_keywords
  if (input.person_titles && input.person_titles.length) body.person_titles = input.person_titles
  if (input.person_seniorities && input.person_seniorities.length) body.person_seniorities = input.person_seniorities
  if (input.organization_domains && input.organization_domains.length) {
    body.q_organization_domains_list = input.organization_domains
  }
  if (input.person_locations && input.person_locations.length) body.person_locations = input.person_locations
  if (input.organization_num_employees_ranges && input.organization_num_employees_ranges.length) {
    body.organization_num_employees_ranges = input.organization_num_employees_ranges
  }
  body.page = input.page ?? 1
  body.per_page = Math.min(input.per_page ?? 25, 100)

  const r = await apiPost<{
    people?: Array<Record<string, unknown>>
    contacts?: Array<Record<string, unknown>>
    pagination?: unknown
  }>("/mixed_people/search", body)
  if (!r.ok) return r
  const rawPeople = (r.data.people ?? r.data.contacts ?? []) as Array<Record<string, unknown>>
  const people = rawPeople.map(normalizePerson)
  return {
    ok: true,
    data: {
      people,
      pagination: normalizePagination(r.data.pagination),
      apollo_object: "people",
      result_summary: `Found ${people.length} people`,
    },
  }
}

// ---- Get person ----

export interface GetPersonInput {
  person_id: string
}

export async function getPersonImpl(
  input: GetPersonInput,
): Promise<Result<{ person: PersonSummary } & ToolSuccessMeta, ApolloError>> {
  // Apollo does NOT expose a simple GET /people/:id endpoint.
  // Per docs.apollo.io 2026-04: we use POST /people/match with `id` as the
  // identifier — this returns the person's full profile + nested organization
  // WITHOUT consuming credits when only the id is supplied (no email/phone reveal).
  const r = await apiPost<{ person?: Record<string, unknown> }>("/people/match", {
    id: input.person_id,
    reveal_personal_emails: false,
    reveal_phone_number: false,
  })
  if (!r.ok) return r
  if (!r.data.person) {
    return { ok: false, error: { code: "not_found", message: `Apollo person ${input.person_id} not found` } }
  }
  const person = normalizePerson(r.data.person)
  return {
    ok: true,
    data: {
      person,
      apollo_object: "people",
      apollo_record_id: person.id,
      apollo_deep_link: personDeepLink(person.id),
      result_summary: `Fetched person ${person.id}`,
    },
  }
}

// ---- Enrich person ----

export interface EnrichPersonInput {
  first_name?: string
  last_name?: string
  organization_domain?: string
  email?: string
  linkedin_url?: string
  reveal_personal_emails?: boolean
  reveal_phone_number?: boolean
}

export async function enrichPersonImpl(
  input: EnrichPersonInput,
): Promise<
  Result<{ person: PersonSummary; credits_consumed?: number } & ToolSuccessMeta, ApolloError>
> {
  const hasNameTrio = Boolean(input.first_name && input.last_name && input.organization_domain)
  if (!hasNameTrio && !input.email && !input.linkedin_url) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message:
          "Provide one of: (first_name + last_name + organization_domain), email, or linkedin_url.",
      },
    }
  }
  const body: Record<string, unknown> = {
    reveal_personal_emails: input.reveal_personal_emails ?? true,
    reveal_phone_number: input.reveal_phone_number ?? false,
  }
  if (input.first_name) body.first_name = input.first_name
  if (input.last_name) body.last_name = input.last_name
  if (input.organization_domain) body.domain = input.organization_domain
  if (input.email) body.email = input.email
  if (input.linkedin_url) body.linkedin_url = input.linkedin_url

  const r = await apiPost<{
    person?: Record<string, unknown>
    credits_consumed?: number
  }>("/people/match", body)
  if (!r.ok) return r
  if (!r.data.person) {
    return {
      ok: false,
      error: { code: "not_found", message: "Apollo could not match a person to those identifiers." },
    }
  }
  const person = normalizePerson(r.data.person)
  return {
    ok: true,
    data: {
      person,
      credits_consumed: typeof r.data.credits_consumed === "number" ? r.data.credits_consumed : undefined,
      apollo_object: "people",
      apollo_record_id: person.id,
      apollo_deep_link: personDeepLink(person.id),
      result_summary: `Enriched ${person.name ?? person.id}`,
    },
  }
}

// ---- Search organizations ----

export interface SearchOrganizationsInput {
  q_keywords?: string
  organization_domains?: string[]
  industries?: string[]
  num_employees_ranges?: string[]
  technologies?: string[]
  organization_locations?: string[]
  page?: number
  per_page?: number
}

export async function searchOrganizationsImpl(
  input: SearchOrganizationsInput,
): Promise<
  Result<
    { organizations: OrganizationSummary[]; pagination?: PaginationSummary } & ToolSuccessMeta,
    ApolloError
  >
> {
  const body: Record<string, unknown> = {}
  if (input.q_keywords !== undefined) body.q_organization_keyword_tags = [input.q_keywords]
  if (input.organization_domains && input.organization_domains.length) {
    body.q_organization_domains_list = input.organization_domains
  }
  if (input.industries && input.industries.length) body.organization_industry_tag_ids = input.industries
  if (input.num_employees_ranges && input.num_employees_ranges.length) {
    body.organization_num_employees_ranges = input.num_employees_ranges
  }
  if (input.technologies && input.technologies.length) body.currently_using_any_of_technology_uids = input.technologies
  if (input.organization_locations && input.organization_locations.length) {
    body.organization_locations = input.organization_locations
  }
  body.page = input.page ?? 1
  body.per_page = Math.min(input.per_page ?? 25, 100)

  const r = await apiPost<{
    organizations?: Array<Record<string, unknown>>
    accounts?: Array<Record<string, unknown>>
    pagination?: unknown
  }>("/mixed_companies/search", body)
  if (!r.ok) return r
  const rawOrgs = (r.data.organizations ?? r.data.accounts ?? []) as Array<Record<string, unknown>>
  const organizations = rawOrgs.map(normalizeOrganization)
  return {
    ok: true,
    data: {
      organizations,
      pagination: normalizePagination(r.data.pagination),
      apollo_object: "organizations",
      result_summary: `Found ${organizations.length} organizations`,
    },
  }
}

// ---- Get organization ----

export interface GetOrganizationInput {
  organization_id: string
}

export async function getOrganizationImpl(
  input: GetOrganizationInput,
): Promise<
  Result<{ organization: OrganizationSummary } & ToolSuccessMeta, ApolloError>
> {
  const r = await apiGet<{ organization?: Record<string, unknown> }>(
    `/organizations/${encodeURIComponent(input.organization_id)}`,
  )
  if (!r.ok) return r
  if (!r.data.organization) {
    return {
      ok: false,
      error: { code: "not_found", message: `Apollo organization ${input.organization_id} not found` },
    }
  }
  const organization = normalizeOrganization(r.data.organization)
  return {
    ok: true,
    data: {
      organization,
      apollo_object: "organizations",
      apollo_record_id: organization.id,
      apollo_deep_link: organizationDeepLink(organization.id),
      result_summary: `Fetched organization ${organization.id}`,
    },
  }
}

// ---- List sequences ----

export interface ListSequencesInput {
  q_name?: string
  page?: number
  per_page?: number
}

export async function listSequencesImpl(
  input: ListSequencesInput,
): Promise<
  Result<
    { sequences: SequenceSummary[]; pagination?: PaginationSummary } & ToolSuccessMeta,
    ApolloError
  >
> {
  const body: Record<string, unknown> = {
    page: input.page ?? 1,
    per_page: Math.min(input.per_page ?? 50, 100),
  }
  if (input.q_name !== undefined) body.q_name = input.q_name

  const r = await apiPost<{
    emailer_campaigns?: Array<Record<string, unknown>>
    pagination?: unknown
  }>("/emailer_campaigns/search", body)
  if (!r.ok) return r
  const rawSeq = r.data.emailer_campaigns ?? []
  const sequences = rawSeq.map(normalizeSequence)
  return {
    ok: true,
    data: {
      sequences,
      pagination: normalizePagination(r.data.pagination),
      apollo_object: "sequences",
      result_summary: `Found ${sequences.length} sequences`,
    },
  }
}

// ---- Add to sequence ----

export interface AddToSequenceInput {
  sequence_id: string
  contact_ids: string[]
  send_email_from_email_account_id?: string
  sequence_no_email?: boolean
  sequence_active_in_other_campaigns?: boolean
}

export async function addToSequenceImpl(
  input: AddToSequenceInput,
): Promise<
  Result<
    {
      sequence_id: string
      contact_ids: string[]
      added: number
      already_in_sequence: number
    } & ToolSuccessMeta,
    ApolloError
  >
> {
  if (!input.contact_ids.length) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "contact_ids must contain at least one id." },
    }
  }
  const body: Record<string, unknown> = {
    contact_ids: input.contact_ids,
    emailer_campaign_id: input.sequence_id,
    // Apollo requires a sending mailbox id. Re-adding an already-enrolled
    // contact is a server-side no-op, so the tool stays idempotent.
    send_email_from_email_account_id: input.send_email_from_email_account_id,
    sequence_no_email: input.sequence_no_email ?? false,
    sequence_active_in_other_campaigns: input.sequence_active_in_other_campaigns ?? false,
  }
  const r = await apiPost<{
    contacts?: Array<Record<string, unknown>>
    num_added?: number
    num_skipped?: number
  }>(`/emailer_campaigns/${encodeURIComponent(input.sequence_id)}/add_contact_ids`, body)
  if (!r.ok) return r
  const added = typeof r.data.num_added === "number" ? r.data.num_added : (r.data.contacts ?? []).length
  const skipped = typeof r.data.num_skipped === "number" ? r.data.num_skipped : 0
  return {
    ok: true,
    data: {
      sequence_id: input.sequence_id,
      contact_ids: input.contact_ids,
      added,
      already_in_sequence: skipped,
      apollo_object: "sequences",
      apollo_record_id: input.sequence_id,
      apollo_deep_link: sequenceDeepLink(input.sequence_id),
      result_summary:
        skipped > 0
          ? `Added ${added}, ${skipped} already enrolled`
          : `Added ${added} contact(s) to sequence`,
    },
  }
}

// ---- Remove from sequence ----

export interface RemoveFromSequenceInput {
  sequence_id: string
  contact_ids: string[]
  mode?: "remove" | "mark_as_finished"
}

export async function removeFromSequenceImpl(
  input: RemoveFromSequenceInput,
): Promise<
  Result<
    {
      sequence_id: string
      contact_ids: string[]
      removed: number
    } & ToolSuccessMeta,
    ApolloError
  >
> {
  if (!input.contact_ids.length) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "contact_ids must contain at least one id." },
    }
  }
  // Per docs.apollo.io: the official endpoint is
  // POST /emailer_campaigns/remove_or_stop_contact_ids — `mode` switches
  // between hard remove and mark-finished. Idempotent: removing someone not
  // currently in the sequence returns success with `removed: 0`.
  const r = await apiPost<{ num_removed?: number; contacts?: Array<Record<string, unknown>> }>(
    "/emailer_campaigns/remove_or_stop_contact_ids",
    {
      contact_ids: input.contact_ids,
      emailer_campaign_ids: [input.sequence_id],
      mode: input.mode ?? "remove",
    },
  )
  if (!r.ok) return r
  const removed = typeof r.data.num_removed === "number" ? r.data.num_removed : (r.data.contacts ?? []).length
  return {
    ok: true,
    data: {
      sequence_id: input.sequence_id,
      contact_ids: input.contact_ids,
      removed,
      apollo_object: "sequences",
      apollo_record_id: input.sequence_id,
      apollo_deep_link: sequenceDeepLink(input.sequence_id),
      result_summary: `Removed ${removed} contact(s) from sequence`,
    },
  }
}

// ---- List emails sent ----

export interface ListEmailsSentInput {
  contact_id?: string
  sequence_id?: string
  status?: "sent" | "opened" | "replied" | "bounced" | "clicked"
  since?: string
  page?: number
  per_page?: number
}

export async function listEmailsSentImpl(
  input: ListEmailsSentInput,
): Promise<
  Result<
    { emails: EmailEvent[]; pagination?: PaginationSummary } & ToolSuccessMeta,
    ApolloError
  >
> {
  if (!input.contact_id && !input.sequence_id) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "Provide either contact_id or sequence_id to scope the query.",
      },
    }
  }
  const body: Record<string, unknown> = {
    page: input.page ?? 1,
    per_page: Math.min(input.per_page ?? 25, 100),
  }
  if (input.contact_id) body.contact_ids = [input.contact_id]
  if (input.sequence_id) body.emailer_campaign_ids = [input.sequence_id]
  if (input.status) body.email_status = input.status
  if (input.since) body.send_date_min = input.since

  const r = await apiPost<{
    emailer_messages?: Array<Record<string, unknown>>
    pagination?: unknown
  }>("/emailer_messages/search", body)
  if (!r.ok) return r
  const rawEmails = r.data.emailer_messages ?? []
  const emails = rawEmails.map(normalizeEmail)
  return {
    ok: true,
    data: {
      emails,
      pagination: normalizePagination(r.data.pagination),
      apollo_object: "emails",
      result_summary: `Found ${emails.length} email(s)`,
    },
  }
}

// ---- MCP wiring ----

const asText = (result: Result<unknown, ApolloError>) => {
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      structuredContent: result.data as Record<string, unknown>,
    }
  }
  // Flat error envelope per docs/MCP_TOOL_DESCRIPTION_CONVENTION.md §"Errors".
  return { content: [{ type: "text" as const, text: JSON.stringify(result.error) }], isError: true as const }
}

// Output shapes (MCP outputSchema).
const ToolSuccessMetaShape = {
  apollo_object: z.string().optional(),
  apollo_record_id: z.string().optional(),
  apollo_deep_link: z.string().optional(),
  result_summary: z.string().optional(),
}

const PaginationShape = z.object({
  page: z.number(),
  per_page: z.number(),
  total_entries: z.number().nullable(),
  total_pages: z.number().nullable(),
})

const PersonShape = z.object({
  id: z.string(),
  name: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  linkedin_url: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  organization: z
    .object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      domain: z.string().nullable(),
    })
    .nullable(),
})

const OrganizationShape = z.object({
  id: z.string(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
  website_url: z.string().nullable(),
  industry: z.string().nullable(),
  estimated_num_employees: z.number().nullable(),
  founded_year: z.number().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  technology_names: z.array(z.string()),
})

const SequenceShape = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  archived: z.boolean(),
  num_steps: z.number(),
  created_at: z.string().nullable(),
})

const EmailEventShape = z.object({
  id: z.string(),
  contact_id: z.string().nullable(),
  emailer_campaign_id: z.string().nullable(),
  subject: z.string().nullable(),
  status: z.string().nullable(),
  sent_at: z.string().nullable(),
  opened_at: z.string().nullable(),
  replied_at: z.string().nullable(),
  bounced_at: z.string().nullable(),
  clicked_at: z.string().nullable(),
})

const ConnectionStatusShape = {
  connected: z.boolean(),
  user_email: z.string().optional(),
  team_name: z.string().optional(),
  is_master_key: z.boolean().optional(),
  ...ToolSuccessMetaShape,
}

const SearchPeopleShape = {
  people: z.array(PersonShape),
  pagination: PaginationShape.optional(),
  ...ToolSuccessMetaShape,
}

const PersonOneShape = { person: PersonShape, ...ToolSuccessMetaShape }
const EnrichPersonShape = {
  person: PersonShape,
  credits_consumed: z.number().optional(),
  ...ToolSuccessMetaShape,
}
const SearchOrgsShape = {
  organizations: z.array(OrganizationShape),
  pagination: PaginationShape.optional(),
  ...ToolSuccessMetaShape,
}
const OrganizationOneShape = { organization: OrganizationShape, ...ToolSuccessMetaShape }
const SequencesListShape = {
  sequences: z.array(SequenceShape),
  pagination: PaginationShape.optional(),
  ...ToolSuccessMetaShape,
}
const AddToSequenceShape = {
  sequence_id: z.string(),
  contact_ids: z.array(z.string()),
  added: z.number(),
  already_in_sequence: z.number(),
  ...ToolSuccessMetaShape,
}
const RemoveFromSequenceShape = {
  sequence_id: z.string(),
  contact_ids: z.array(z.string()),
  removed: z.number(),
  ...ToolSuccessMetaShape,
}
const EmailsListShape = {
  emails: z.array(EmailEventShape),
  pagination: PaginationShape.optional(),
  ...ToolSuccessMetaShape,
}

export function registerTools(server: McpServer): void {
  const getConnectionStatus = wrapTool("apollo_get_connection_status", getConnectionStatusImpl)
  const searchPeople = wrapTool("apollo_search_people", searchPeopleImpl)
  const getPerson = wrapTool("apollo_get_person", getPersonImpl)
  const enrichPerson = wrapTool("apollo_enrich_person", enrichPersonImpl)
  const searchOrganizations = wrapTool("apollo_search_organizations", searchOrganizationsImpl)
  const getOrganization = wrapTool("apollo_get_organization", getOrganizationImpl)
  const listSequences = wrapTool("apollo_list_sequences", listSequencesImpl)
  const addToSequence = wrapTool("apollo_add_to_sequence", addToSequenceImpl)
  const removeFromSequence = wrapTool("apollo_remove_from_sequence", removeFromSequenceImpl)
  const listEmailsSent = wrapTool("apollo_list_emails_sent", listEmailsSentImpl)

  server.registerTool(
    "apollo_get_connection_status",
    {
      title: "Check Apollo connection",
      description: `Check whether Apollo.io is connected for this workspace.

When to use: ALWAYS call this first if any Apollo tool returns a not_connected error, or before suggesting Apollo features for the first time.
Returns: { connected: true, user_email?, team_name?, is_master_key? } if linked, { connected: false } otherwise. is_master_key=false means write tools (apollo_add_to_sequence, apollo_remove_from_sequence) and some read endpoints (apollo_list_sequences, apollo_list_emails_sent) will return not_connected — the user must regenerate their Apollo API key as a master key. If false, tell the user to connect Apollo from the Holaboss integrations page.`,
      inputSchema: {},
      outputSchema: ConnectionStatusShape,
      annotations: {
        title: "Check Apollo connection",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => asText(await getConnectionStatus({})),
  )

  server.registerTool(
    "apollo_search_people",
    {
      title: "Search Apollo people",
      description: `Search Apollo's 275M-person database by title, company, location, headcount, or seniority.

When to use: prospecting — "find VPs of Engineering at Series-B SaaS in California". Pass any combination of filters; the more specific, the better.
When NOT to use: if you already have a person id, use apollo_get_person. If you only have name + domain and need a verified email, use apollo_enrich_person.
Returns: { people: [{ id, name, title, organization, location, ... }], pagination }. Email field will typically be null on free/team plans — call apollo_enrich_person to reveal it. (Defaulted to email-omitted per plan §10 question 5; verify against your Apollo plan.)`,
      inputSchema: {
        q_keywords: z
          .string()
          .optional()
          .describe(
            "Free-text keywords across name/title/headline, e.g. 'staff engineer kubernetes'.",
          ),
        person_titles: z
          .array(z.string())
          .optional()
          .describe(
            "Job titles to match (OR), e.g. ['VP Engineering', 'Director of Engineering'].",
          ),
        person_seniorities: z
          .array(
            z.enum([
              "owner",
              "founder",
              "c_suite",
              "partner",
              "vp",
              "head",
              "director",
              "manager",
              "senior",
              "entry",
              "intern",
            ]),
          )
          .optional()
          .describe("Seniority buckets to match (OR)."),
        organization_domains: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict to people at these companies, by domain. e.g. ['acme.com', 'globex.com'].",
          ),
        person_locations: z
          .array(z.string())
          .optional()
          .describe("Geographies, e.g. ['California, US', 'New York, US', 'United Kingdom']."),
        organization_num_employees_ranges: z
          .array(z.string())
          .optional()
          .describe(
            "Headcount ranges as 'min,max' strings, e.g. ['51,200', '201,500', '501,1000'].",
          ),
        page: z.number().int().positive().optional().describe("Page number, default 1."),
        per_page: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Default 25, max 100."),
      },
      outputSchema: SearchPeopleShape,
      annotations: {
        title: "Search Apollo people",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await searchPeople(args)),
  )

  server.registerTool(
    "apollo_get_person",
    {
      title: "Get Apollo person",
      description: `Fetch full details for a single Apollo person by id, including their nested organization.

When to use: after apollo_search_people returns an id and you want the complete profile.
When NOT to use: if you need a verified email/phone — use apollo_enrich_person (consumes credits, but reveals contact info).
Prerequisites: person_id from apollo_search_people.
Returns: { person: { id, name, title, organization, location, ... } }. Email/phone are NOT revealed by this tool.
Errors: { code: 'not_found' } if the id doesn't resolve.`,
      inputSchema: {
        person_id: z
          .string()
          .describe("Apollo person id, e.g. '5f2a4b6c8d9e0f1a2b3c4d5e' (from apollo_search_people)."),
      },
      outputSchema: PersonOneShape,
      annotations: {
        title: "Get Apollo person",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await getPerson(args)),
  )

  server.registerTool(
    "apollo_enrich_person",
    {
      title: "Enrich Apollo person",
      description: `Find a verified email and (optionally) phone for a person by name + domain, email, or LinkedIn URL. CONSUMES CREDITS on every successful match.

When to use: only when the user explicitly asks for an email/phone, or when apollo_search_people / apollo_get_person returned a person but no email. Don't speculatively fan out across every search hit.
Inputs: at minimum (first_name + last_name + organization_domain) OR email OR linkedin_url.
Returns: { person: { id, name, email, ... }, credits_consumed }.
Errors: { code: 'validation_failed' } if the identifier trio is incomplete. { code: 'not_found' } if Apollo can't match. { code: 'rate_limited' } when daily credit cap is hit — backoff and retry next billing window.`,
      inputSchema: {
        first_name: z
          .string()
          .optional()
          .describe("First name, e.g. 'Jane'. Required when matching by name+domain."),
        last_name: z
          .string()
          .optional()
          .describe("Last name, e.g. 'Smith'. Required when matching by name+domain."),
        organization_domain: z
          .string()
          .optional()
          .describe("Company domain, e.g. 'acme.com'. Required when matching by name+domain."),
        email: z
          .string()
          .optional()
          .describe("Known email, e.g. 'jane@acme.com'. Apollo will confirm and enrich."),
        linkedin_url: z
          .string()
          .optional()
          .describe("LinkedIn profile URL, e.g. 'https://www.linkedin.com/in/janesmith'."),
        reveal_personal_emails: z
          .boolean()
          .optional()
          .describe("Default true — also return personal (non-work) emails when available."),
        reveal_phone_number: z
          .boolean()
          .optional()
          .describe("Default false — set true to also reveal phone (extra credit cost)."),
      },
      outputSchema: EnrichPersonShape,
      annotations: {
        title: "Enrich Apollo person",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await enrichPerson(args)),
  )

  server.registerTool(
    "apollo_search_organizations",
    {
      title: "Search Apollo organizations",
      description: `Search Apollo's company database by industry, headcount, geography, or tech stack.

When to use: company prospecting — "Series B SaaS in California using Snowflake". Pass any combination of filters.
When NOT to use: if you already have an organization id, use apollo_get_organization.
Returns: { organizations: [{ id, name, domain, industry, headcount, technology_names, ... }], pagination }.`,
      inputSchema: {
        q_keywords: z
          .string()
          .optional()
          .describe("Free-text keywords across name/description, e.g. 'developer tools security'."),
        organization_domains: z
          .array(z.string())
          .optional()
          .describe("Match these exact domains, e.g. ['acme.com', 'globex.com']."),
        industries: z
          .array(z.string())
          .optional()
          .describe("Industry tag ids from Apollo, e.g. ['saas', 'fintech']."),
        num_employees_ranges: z
          .array(z.string())
          .optional()
          .describe("Headcount as 'min,max' strings, e.g. ['11,50', '51,200', '201,500']."),
        technologies: z
          .array(z.string())
          .optional()
          .describe(
            "Technology slug ids the company uses, e.g. ['salesforce', 'snowflake', 'stripe'].",
          ),
        organization_locations: z
          .array(z.string())
          .optional()
          .describe("HQ geographies, e.g. ['California, US', 'United Kingdom']."),
        page: z.number().int().positive().optional().describe("Page number, default 1."),
        per_page: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Default 25, max 100."),
      },
      outputSchema: SearchOrgsShape,
      annotations: {
        title: "Search Apollo organizations",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await searchOrganizations(args)),
  )

  server.registerTool(
    "apollo_get_organization",
    {
      title: "Get Apollo organization",
      description: `Fetch full details for a single Apollo organization by id (industry, headcount, tech stack, founding year, location).

When to use: after apollo_search_organizations returns an id and you need the complete profile.
Prerequisites: organization_id from apollo_search_organizations or from a person's organization.id.
Returns: { organization: { id, name, domain, industry, estimated_num_employees, technology_names, ... } }.
Note: this endpoint CONSUMES CREDITS per Apollo's API pricing (one credit per call as of 2026-04). Don't fan out across many ids speculatively.
Errors: { code: 'not_found' } if the id doesn't resolve.`,
      inputSchema: {
        organization_id: z
          .string()
          .describe("Apollo organization id, e.g. '5f2a4b6c8d9e0f1a2b3c4d5e'."),
      },
      outputSchema: OrganizationOneShape,
      annotations: {
        title: "Get Apollo organization",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await getOrganization(args)),
  )

  server.registerTool(
    "apollo_list_sequences",
    {
      title: "List Apollo sequences",
      description: `List the team's email sequences (multi-step cadences) with id, name, status, and step count.

When to use: BEFORE apollo_add_to_sequence — agent needs a sequence_id and the user needs to confirm which cadence to enroll the contact in.
When NOT to use: if the user names a specific sequence, you still need to call this to map the name to an id.
Returns: { sequences: [{ id, name, active, archived, num_steps, created_at }], pagination }. active=true means the sequence is currently sending; archived=true means it's been retired.
Errors: { code: 'not_connected' } if the Apollo API key isn't a master key (this endpoint requires master). Tell the user to regenerate.`,
      inputSchema: {
        q_name: z
          .string()
          .optional()
          .describe("Filter by sequence name fragment, e.g. 'Q2 Outbound'."),
        page: z.number().int().positive().optional().describe("Page number, default 1."),
        per_page: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Default 50, max 100."),
      },
      outputSchema: SequencesListShape,
      annotations: {
        title: "List Apollo sequences",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await listSequences(args)),
  )

  server.registerTool(
    "apollo_add_to_sequence",
    {
      title: "Add contacts to sequence",
      description: `Enroll one or more contacts into an Apollo email sequence (cadence). Idempotent — re-adding an already-enrolled contact is a no-op.

When to use: the user has approved a sequence and wants people enrolled. Pass multiple contact_ids to bulk-add.
Prerequisites: sequence_id from apollo_list_sequences; contact_ids from apollo_search_people / apollo_enrich_person; send_email_from_email_account_id is the mailbox id that will send (omit to use Apollo's default; if Apollo rejects, fetch via the mailbox list endpoint and pass it explicitly).
Side effects: enrolled contacts start receiving sequence emails on the next scheduled send.
Returns: { sequence_id, contact_ids, added, already_in_sequence }. added is the number actually enrolled this call; already_in_sequence is the number skipped because they were already in.
Errors: { code: 'not_connected' } if the API key isn't a master key. { code: 'validation_failed' } if Apollo rejects the payload (e.g. mailbox id missing).`,
      inputSchema: {
        sequence_id: z
          .string()
          .describe("Apollo sequence id (from apollo_list_sequences)."),
        contact_ids: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe(
            "Apollo contact ids, max 100 per call. e.g. ['5f2a...','5f2b...']. Pass multiple to bulk-add.",
          ),
        send_email_from_email_account_id: z
          .string()
          .optional()
          .describe(
            "Apollo email account (mailbox) id used to send. Omit to use the sequence's default mailbox.",
          ),
        sequence_no_email: z
          .boolean()
          .optional()
          .describe("Default false. Set true to enroll without sending the first email immediately."),
        sequence_active_in_other_campaigns: z
          .boolean()
          .optional()
          .describe(
            "Default false. Set true to allow enrolling contacts already active in another sequence.",
          ),
      },
      outputSchema: AddToSequenceShape,
      annotations: {
        title: "Add contacts to sequence",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await addToSequence(args)),
  )

  server.registerTool(
    "apollo_remove_from_sequence",
    {
      title: "Remove contacts from sequence",
      description: `Remove one or more contacts from an Apollo email sequence, or mark them as having finished it. Idempotent — removing someone not currently enrolled returns success with removed=0.

When to use: stop sending sequence emails to specific people, e.g. they replied, opted out, or were enrolled by mistake.
Prerequisites: sequence_id from apollo_list_sequences; contact_ids from apollo_search_people. mode='remove' (default) hard-removes; mode='mark_as_finished' keeps history but stops further sends.
Side effects: those contacts will not receive any further emails from this sequence.
Returns: { sequence_id, contact_ids, removed }.
Errors: { code: 'not_connected' } if the API key isn't a master key.`,
      inputSchema: {
        sequence_id: z
          .string()
          .describe("Apollo sequence id (from apollo_list_sequences)."),
        contact_ids: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe(
            "Apollo contact ids to remove/finish, max 100 per call. e.g. ['5f2a...','5f2b...'].",
          ),
        mode: z
          .enum(["remove", "mark_as_finished"])
          .optional()
          .describe(
            "Default 'remove' — hard-remove from sequence. Use 'mark_as_finished' to keep the contact's send history and stop further sends.",
          ),
      },
      outputSchema: RemoveFromSequenceShape,
      annotations: {
        title: "Remove contacts from sequence",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await removeFromSequence(args)),
  )

  server.registerTool(
    "apollo_list_emails_sent",
    {
      title: "List Apollo emails sent",
      description: `Recent send activity from Apollo sequences — sent, opened, replied, bounced, clicked. Filter by contact, sequence, status, or date.

When to use: reporting — "did Bob from Acme reply?", "everyone we contacted at Acme in the last 30 days", "bounce rate on Q2 sequence". One of contact_id or sequence_id is REQUIRED — Apollo refuses unscoped queries.
Returns: { emails: [{ id, contact_id, emailer_campaign_id, subject, status, sent_at, opened_at, replied_at, ... }], pagination }.
Errors: { code: 'validation_failed' } if neither contact_id nor sequence_id is provided. { code: 'not_connected' } if the API key isn't a master key.`,
      inputSchema: {
        contact_id: z
          .string()
          .optional()
          .describe(
            "Filter by recipient. Either this OR sequence_id is required. (from apollo_search_people).",
          ),
        sequence_id: z
          .string()
          .optional()
          .describe("Filter by sequence (from apollo_list_sequences)."),
        status: z
          .enum(["sent", "opened", "replied", "bounced", "clicked"])
          .optional()
          .describe("Filter by latest event on the email."),
        since: z
          .string()
          .optional()
          .describe(
            "ISO 8601 date, e.g. '2026-04-01T00:00:00Z'. Only emails sent on or after this time are returned.",
          ),
        page: z.number().int().positive().optional().describe("Page number, default 1."),
        per_page: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Default 25, max 100."),
      },
      outputSchema: EmailsListShape,
      annotations: {
        title: "List Apollo emails sent",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await listEmailsSent(args)),
  )
}
