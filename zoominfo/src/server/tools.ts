import { z } from "zod"

import { apiGet, apiPost } from "./zoominfo-client"
import { wrapTool } from "./audit"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type {
  CompanyDetail,
  CompanySummary,
  ContactDetail,
  ContactSummary,
  ExecutiveSummary,
  IntentTopic,
  Result,
  ToolSuccessMeta,
  ZoomInfoError,
} from "../lib/types"

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint paths verified against https://docs.zoominfo.com/ in Phase 0.
// Corrections from the original plan §3:
//   - intent endpoint is `/enrich/intent` (not `/intent`).
//   - pagination is page-based (`rpp` + `page`), not cursor-based.
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_CONTACT = "/search/contact"
const SEARCH_COMPANY = "/search/company"
const ENRICH_CONTACT = "/enrich/contact"
const ENRICH_COMPANY = "/enrich/company"
const ENRICH_INTENT = "/enrich/intent"

// Contact output fields requested from /enrich/contact. Keep this list narrow
// to control the response payload. Fields verified against ZoomInfo docs.
const CONTACT_OUTPUT_FIELDS = [
  "id",
  "firstName",
  "lastName",
  "jobTitle",
  "managementLevel",
  "jobFunction",
  "companyId",
  "companyName",
  "companyDomain",
  "email",
  "directPhoneDoNotCall",
  "mobilePhoneDoNotCall",
  "street",
  "city",
  "region",
  "country",
  "linkedinProfileUrl",
] as const

const COMPANY_OUTPUT_FIELDS = [
  "id",
  "name",
  "website",
  "industry",
  "employeeCount",
  "revenue",
  "country",
  "description",
  "foundedYear",
  "techAttributes",
  "departmentBudgets",
  "recentNews",
  "socialMediaUrls",
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Normalizers — convert ZoomInfo's verbose field names to a stable shape.
// ─────────────────────────────────────────────────────────────────────────────

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function normalizeContactSummary(raw: Record<string, unknown>): ContactSummary {
  return {
    id: String(raw.id ?? raw.contactId ?? raw.personId ?? ""),
    first_name: asStringOrNull(raw.firstName),
    last_name: asStringOrNull(raw.lastName),
    job_title: asStringOrNull(raw.jobTitle),
    management_level: asStringOrNull(raw.managementLevel ?? raw.managementLevels),
    job_function: asStringOrNull(raw.jobFunction ?? raw.jobFunctions),
    company_id: asStringOrNull(raw.companyId) ?? (raw.company ? asStringOrNull((raw.company as Record<string, unknown>).id) : null),
    company_name: asStringOrNull(raw.companyName) ?? (raw.company ? asStringOrNull((raw.company as Record<string, unknown>).name) : null),
    company_domain: asStringOrNull(raw.companyDomain ?? raw.companyWebsite),
    location_country: asStringOrNull(raw.country),
    location_state: asStringOrNull(raw.region ?? raw.state),
  }
}

function normalizeContactDetail(raw: Record<string, unknown>): ContactDetail {
  const summary = normalizeContactSummary(raw)
  return {
    ...summary,
    email: asStringOrNull(raw.email),
    direct_phone: asStringOrNull(raw.directPhoneDoNotCall ?? raw.directPhone),
    mobile_phone: asStringOrNull(raw.mobilePhoneDoNotCall ?? raw.mobilePhone),
    business_address: composeAddress(raw),
    linkedin_url: asStringOrNull(raw.linkedinProfileUrl ?? raw.linkedinUrl),
  }
}

function composeAddress(raw: Record<string, unknown>): string | null {
  const parts = [raw.street, raw.city, raw.region ?? raw.state, raw.country, raw.zipCode]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
  return parts.length > 0 ? parts.join(", ") : null
}

function normalizeCompanySummary(raw: Record<string, unknown>): CompanySummary {
  return {
    id: String(raw.id ?? raw.companyId ?? ""),
    name: String(raw.name ?? raw.companyName ?? ""),
    domain: asStringOrNull(raw.website ?? raw.companyDomain ?? raw.companyWebsite),
    industry: asStringOrNull(raw.industry ?? (Array.isArray(raw.industries) && raw.industries[0])),
    employee_count: asNumberOrNull(raw.employeeCount),
    revenue: asNumberOrNull(raw.revenue),
    location_country: asStringOrNull(raw.country),
  }
}

function normalizeCompanyDetail(raw: Record<string, unknown>): CompanyDetail {
  const summary = normalizeCompanySummary(raw)
  const techRaw = raw.techAttributes
  const technologies: Array<string> = Array.isArray(techRaw)
    ? techRaw
        .map((t) => {
          if (typeof t === "string") return t
          if (t && typeof t === "object") {
            const name = (t as Record<string, unknown>).name ?? (t as Record<string, unknown>).product
            return typeof name === "string" ? name : null
          }
          return null
        })
        .filter((s): s is string => s !== null)
    : []
  const deptRaw = raw.departmentBudgets
  const employee_count_by_department: Record<string, number> = {}
  if (Array.isArray(deptRaw)) {
    for (const d of deptRaw) {
      if (d && typeof d === "object") {
        const name = (d as Record<string, unknown>).department ?? (d as Record<string, unknown>).name
        const count = (d as Record<string, unknown>).employeeCount ?? (d as Record<string, unknown>).count
        if (typeof name === "string" && typeof count === "number") {
          employee_count_by_department[name] = count
        }
      }
    }
  }
  const newsRaw = raw.recentNews
  const recent_news: Array<string> = Array.isArray(newsRaw)
    ? newsRaw
        .map((n) => {
          if (typeof n === "string") return n
          if (n && typeof n === "object") {
            const title = (n as Record<string, unknown>).title ?? (n as Record<string, unknown>).headline
            return typeof title === "string" ? title : null
          }
          return null
        })
        .filter((s): s is string => s !== null)
    : []
  let linkedin_url: string | null = null
  const social = raw.socialMediaUrls
  if (Array.isArray(social)) {
    const li = social.find((s) => {
      if (!s || typeof s !== "object") return false
      const type = (s as Record<string, unknown>).type
      return typeof type === "string" && type.toLowerCase().includes("linkedin")
    })
    if (li && typeof li === "object") {
      linkedin_url = asStringOrNull((li as Record<string, unknown>).url)
    }
  }
  return {
    ...summary,
    description: asStringOrNull(raw.description),
    founded_year: asNumberOrNull(raw.foundedYear),
    technologies,
    employee_count_by_department,
    recent_news,
    linkedin_url,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementations
// ─────────────────────────────────────────────────────────────────────────────

export interface GetConnectionStatusInput {
  // empty
}

export async function getConnectionStatusImpl(
  _input: Record<string, never>,
): Promise<Result<{ connected: boolean } & ToolSuccessMeta, ZoomInfoError>> {
  // Cheapest probe through the @holaboss/bridge proxy: a metadata GET that
  // doesn't consume credits. The broker handles ZoomInfo's auth dance
  // internally — a 2xx here proves both connectivity and credential validity.
  // (Per Phase 0: ZoomInfo does not expose `daily_quota_remaining` on a public
  // endpoint we can hit without additional setup, so it is omitted from
  // outputSchema — see plan §10.)
  const r = await apiGet<unknown>("/lookup/inputfields/contact/search")
  if (r.ok) {
    return {
      ok: true,
      data: {
        connected: true,
        zoominfo_object: "account",
        result_summary: "ZoomInfo connection verified",
      },
    }
  }
  if (r.error.code === "not_connected") {
    return {
      ok: true,
      data: {
        connected: false,
        zoominfo_object: "account",
        result_summary: "ZoomInfo not connected",
      },
    }
  }
  return { ok: false, error: r.error }
}

export interface SearchContactsInput {
  job_titles?: Array<string>
  management_levels?: Array<"c_level" | "vp_level" | "director_level" | "manager_level" | "non_manager">
  job_functions?: Array<string>
  company_ids?: Array<string>
  company_domains?: Array<string>
  locations?: Array<string>
  page?: number
  page_size?: number
}

const MANAGEMENT_LEVEL_MAP: Record<NonNullable<SearchContactsInput["management_levels"]>[number], string> = {
  c_level: "C-Level",
  vp_level: "VP-Level",
  director_level: "Director",
  manager_level: "Manager",
  non_manager: "Non-Manager",
}

export async function searchContactsImpl(
  input: SearchContactsInput,
): Promise<
  Result<
    { contacts: Array<ContactSummary>; page: number; page_size: number; has_next: boolean } & ToolSuccessMeta,
    ZoomInfoError
  >
> {
  const page = input.page ?? 1
  const rpp = Math.min(input.page_size ?? 25, 100)
  const body: Record<string, unknown> = { page, rpp }

  if (input.job_titles && input.job_titles.length > 0) body.jobTitle = input.job_titles.join(",")
  if (input.management_levels && input.management_levels.length > 0) {
    body.managementLevel = input.management_levels.map((l) => MANAGEMENT_LEVEL_MAP[l]).join(",")
  }
  if (input.job_functions && input.job_functions.length > 0) body.jobFunction = input.job_functions.join(",")
  if (input.company_ids && input.company_ids.length > 0) body.companyId = input.company_ids.join(",")
  if (input.company_domains && input.company_domains.length > 0) body.companyWebsite = input.company_domains.join(",")
  if (input.locations && input.locations.length > 0) {
    // Heuristic: if it looks like "US-CA" treat as country+state, else country.
    const countries: Array<string> = []
    const states: Array<string> = []
    for (const loc of input.locations) {
      const dash = loc.indexOf("-")
      if (dash > 0) {
        countries.push(loc.slice(0, dash))
        states.push(loc.slice(dash + 1))
      } else {
        countries.push(loc)
      }
    }
    if (countries.length > 0) body.country = countries.join(",")
    if (states.length > 0) body.state = states.join(",")
  }

  const r = await apiPost<{
    currentPage?: number
    maxResults?: number
    totalResults?: number
    data?: Array<Record<string, unknown>>
  }>(SEARCH_CONTACT, body)
  if (!r.ok) return r
  const items = r.data.data ?? []
  const contacts = items.map(normalizeContactSummary)
  const totalResults = r.data.totalResults ?? contacts.length
  const has_next = page * rpp < totalResults
  return {
    ok: true,
    data: {
      contacts,
      page,
      page_size: rpp,
      has_next,
      zoominfo_object: "contacts",
      result_summary: `Found ${contacts.length} contact(s) (page ${page} of ${Math.max(1, Math.ceil(totalResults / rpp))})`,
    },
  }
}

export interface EnrichContactInput {
  contact_id?: string
  first_name?: string
  last_name?: string
  company_id?: string
  company_domain?: string
  email?: string
}

export async function enrichContactImpl(
  input: EnrichContactInput,
): Promise<Result<{ contact: ContactDetail } & ToolSuccessMeta, ZoomInfoError>> {
  // Validation — ZoomInfo accepts several shapes; we require the agent to
  // provide one of them so we don't burn credits on an empty match.
  const hasId = Boolean(input.contact_id)
  const hasEmail = Boolean(input.email)
  const hasNameAndCompany =
    Boolean(input.first_name) &&
    Boolean(input.last_name) &&
    (Boolean(input.company_id) || Boolean(input.company_domain))
  if (!hasId && !hasEmail && !hasNameAndCompany) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message:
          "Provide one of: contact_id, email, or (first_name + last_name + (company_id or company_domain)).",
      },
    }
  }

  const matchEntry: Record<string, unknown> = {}
  if (input.contact_id) matchEntry.personId = input.contact_id
  if (input.email) matchEntry.emailAddress = input.email
  if (input.first_name) matchEntry.firstName = input.first_name
  if (input.last_name) matchEntry.lastName = input.last_name
  if (input.company_id) matchEntry.companyId = input.company_id
  if (input.company_domain) matchEntry.companyWebsite = input.company_domain

  const body = {
    matchPersonInput: [matchEntry],
    outputFields: CONTACT_OUTPUT_FIELDS,
  }

  const r = await apiPost<{
    success?: boolean
    data?: { result?: Array<{ data?: Array<Record<string, unknown>> }> }
  }>(ENRICH_CONTACT, body)
  if (!r.ok) return r
  const firstResult = r.data.data?.result?.[0]
  const firstMatch = firstResult?.data?.[0]
  if (!firstMatch) {
    return {
      ok: false,
      error: { code: "not_found", message: "No ZoomInfo contact matched the input." },
    }
  }
  const contact = normalizeContactDetail(firstMatch)
  return {
    ok: true,
    data: {
      contact,
      zoominfo_object: "contact",
      zoominfo_record_id: contact.id || undefined,
      result_summary: `Enriched ${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Enriched contact",
    },
  }
}

export interface SearchCompaniesInput {
  industries?: Array<string>
  employee_count_ranges?: Array<string>
  revenue_ranges?: Array<string>
  locations?: Array<string>
  technologies?: Array<string>
  page?: number
  page_size?: number
}

export async function searchCompaniesImpl(
  input: SearchCompaniesInput,
): Promise<
  Result<
    { companies: Array<CompanySummary>; page: number; page_size: number; has_next: boolean } & ToolSuccessMeta,
    ZoomInfoError
  >
> {
  const page = input.page ?? 1
  const rpp = Math.min(input.page_size ?? 25, 100)
  const body: Record<string, unknown> = { page, rpp }
  if (input.industries && input.industries.length > 0) body.industry = input.industries.join(",")
  if (input.employee_count_ranges && input.employee_count_ranges.length > 0) {
    body.employeeCount = input.employee_count_ranges.join(",")
  }
  if (input.revenue_ranges && input.revenue_ranges.length > 0) body.revenue = input.revenue_ranges.join(",")
  if (input.locations && input.locations.length > 0) body.country = input.locations.join(",")
  if (input.technologies && input.technologies.length > 0) body.techAttribute = input.technologies.join(",")

  const r = await apiPost<{
    currentPage?: number
    totalResults?: number
    data?: Array<Record<string, unknown>>
  }>(SEARCH_COMPANY, body)
  if (!r.ok) return r
  const items = r.data.data ?? []
  const companies = items.map(normalizeCompanySummary)
  const totalResults = r.data.totalResults ?? companies.length
  const has_next = page * rpp < totalResults
  return {
    ok: true,
    data: {
      companies,
      page,
      page_size: rpp,
      has_next,
      zoominfo_object: "companies",
      result_summary: `Found ${companies.length} company(ies) (page ${page} of ${Math.max(1, Math.ceil(totalResults / rpp))})`,
    },
  }
}

export interface EnrichCompanyInput {
  company_id?: string
  company_domain?: string
  company_name?: string
}

export async function enrichCompanyImpl(
  input: EnrichCompanyInput,
): Promise<Result<{ company: CompanyDetail } & ToolSuccessMeta, ZoomInfoError>> {
  if (!input.company_id && !input.company_domain && !input.company_name) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "Provide at least one of: company_id, company_domain, company_name.",
      },
    }
  }
  const matchEntry: Record<string, unknown> = {}
  if (input.company_id) matchEntry.companyId = input.company_id
  if (input.company_domain) matchEntry.companyWebsite = input.company_domain
  if (input.company_name) matchEntry.companyName = input.company_name

  const body = {
    matchCompanyInput: [matchEntry],
    outputFields: COMPANY_OUTPUT_FIELDS,
  }
  const r = await apiPost<{
    data?: { result?: Array<{ data?: Array<Record<string, unknown>> }> }
  }>(ENRICH_COMPANY, body)
  if (!r.ok) return r
  const firstMatch = r.data.data?.result?.[0]?.data?.[0]
  if (!firstMatch) {
    return {
      ok: false,
      error: { code: "not_found", message: "No ZoomInfo company matched the input." },
    }
  }
  const company = normalizeCompanyDetail(firstMatch)
  return {
    ok: true,
    data: {
      company,
      zoominfo_object: "company",
      zoominfo_record_id: company.id || undefined,
      result_summary: `Enriched ${company.name}`,
    },
  }
}

export interface GetIntentInput {
  company_id?: string
  company_domain?: string
  topics?: Array<string>
}

export async function getIntentImpl(
  input: GetIntentInput,
): Promise<Result<{ company_id: string | null; intent_topics: Array<IntentTopic> } & ToolSuccessMeta, ZoomInfoError>> {
  if (!input.company_id && !input.company_domain) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "Provide one of: company_id or company_domain.",
      },
    }
  }
  // Per Phase 0 endpoint review, intent uses `/enrich/intent`. The legacy
  // plan path `/intent` does not exist — see plan §3 correction.
  const matchEntry: Record<string, unknown> = {}
  if (input.company_id) matchEntry.companyId = input.company_id
  if (input.company_domain) matchEntry.companyWebsite = input.company_domain
  const body: Record<string, unknown> = {
    matchCompanyInput: [matchEntry],
  }
  if (input.topics && input.topics.length > 0) {
    body.topics = input.topics
  }
  const r = await apiPost<{
    data?: {
      result?: Array<{
        data?: Array<{
          companyId?: string | number
          intent?: Array<{ topic?: string; signalScore?: number; trendingFlag?: boolean; lastTrendingDate?: string }>
        }>
      }>
    }
  }>(ENRICH_INTENT, body)
  if (!r.ok) return r
  const first = r.data.data?.result?.[0]?.data?.[0]
  if (!first) {
    return {
      ok: false,
      error: { code: "not_found", message: "No intent data for this company." },
    }
  }
  const company_id = first.companyId !== undefined ? String(first.companyId) : (input.company_id ?? null)
  const intent_topics: Array<IntentTopic> = (first.intent ?? []).map((t) => ({
    topic: String(t.topic ?? ""),
    score: typeof t.signalScore === "number" ? t.signalScore : 0,
    trending_since: typeof t.lastTrendingDate === "string" ? t.lastTrendingDate : null,
  }))
  return {
    ok: true,
    data: {
      company_id,
      intent_topics,
      zoominfo_object: "intent",
      zoominfo_record_id: company_id ?? undefined,
      result_summary: `Returned ${intent_topics.length} intent topic(s)`,
    },
  }
}

export interface GetOrgChartInput {
  company_id?: string
  company_domain?: string
  levels?: Array<"c_level" | "vp_level" | "director_level">
}

export async function getOrgChartImpl(
  input: GetOrgChartInput,
): Promise<Result<{ company_id: string | null; executives: Array<ExecutiveSummary> } & ToolSuccessMeta, ZoomInfoError>> {
  if (!input.company_id && !input.company_domain) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "Provide one of: company_id or company_domain.",
      },
    }
  }
  const levels = input.levels ?? ["c_level", "vp_level"]
  const body: Record<string, unknown> = {
    page: 1,
    rpp: 100,
    managementLevel: levels.map((l) => MANAGEMENT_LEVEL_MAP[l]).join(","),
  }
  if (input.company_id) body.companyId = input.company_id
  if (input.company_domain) body.companyWebsite = input.company_domain

  const r = await apiPost<{
    data?: Array<Record<string, unknown>>
  }>(SEARCH_CONTACT, body)
  if (!r.ok) return r
  const items = r.data.data ?? []
  const executives: Array<ExecutiveSummary> = items.map((raw) => {
    const summary = normalizeContactSummary(raw)
    return {
      id: summary.id,
      first_name: summary.first_name,
      last_name: summary.last_name,
      job_title: summary.job_title,
      management_level: summary.management_level,
      job_function: summary.job_function,
    }
  })
  const company_id = input.company_id ?? (executives[0]?.id ? null : null)
  return {
    ok: true,
    data: {
      company_id,
      executives,
      zoominfo_object: "org_chart",
      zoominfo_record_id: input.company_id ?? undefined,
      result_summary: `Returned ${executives.length} executive(s) (${levels.join(", ")})`,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP wiring
// ─────────────────────────────────────────────────────────────────────────────

const asText = (result: Result<unknown, ZoomInfoError>) => {
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      structuredContent: result.data as Record<string, unknown>,
    }
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
    isError: true as const,
    structuredContent: result.error as unknown as Record<string, unknown>,
  }
}

const ToolSuccessMetaShape = {
  zoominfo_object: z.string().optional(),
  zoominfo_record_id: z.string().optional(),
  zoominfo_deep_link: z.string().optional(),
  result_summary: z.string().optional(),
}

const ContactSummarySchema = z.object({
  id: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  job_title: z.string().nullable(),
  management_level: z.string().nullable(),
  job_function: z.string().nullable(),
  company_id: z.string().nullable(),
  company_name: z.string().nullable(),
  company_domain: z.string().nullable(),
  location_country: z.string().nullable(),
  location_state: z.string().nullable(),
})

const ContactDetailSchema = ContactSummarySchema.extend({
  email: z.string().nullable(),
  direct_phone: z.string().nullable(),
  mobile_phone: z.string().nullable(),
  business_address: z.string().nullable(),
  linkedin_url: z.string().nullable(),
})

const CompanySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  employee_count: z.number().nullable(),
  revenue: z.number().nullable(),
  location_country: z.string().nullable(),
})

const CompanyDetailSchema = CompanySummarySchema.extend({
  description: z.string().nullable(),
  founded_year: z.number().nullable(),
  technologies: z.array(z.string()),
  employee_count_by_department: z.record(z.string(), z.number()),
  recent_news: z.array(z.string()),
  linkedin_url: z.string().nullable(),
})

const IntentTopicSchema = z.object({
  topic: z.string(),
  score: z.number(),
  trending_since: z.string().nullable(),
})

const ExecutiveSummarySchema = z.object({
  id: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  job_title: z.string().nullable(),
  management_level: z.string().nullable(),
  job_function: z.string().nullable(),
})

const ConnectionStatusShape = {
  connected: z.boolean(),
  ...ToolSuccessMetaShape,
}
const SearchContactsShape = {
  contacts: z.array(ContactSummarySchema),
  page: z.number(),
  page_size: z.number(),
  has_next: z.boolean(),
  ...ToolSuccessMetaShape,
}
const EnrichContactShape = {
  contact: ContactDetailSchema,
  ...ToolSuccessMetaShape,
}
const SearchCompaniesShape = {
  companies: z.array(CompanySummarySchema),
  page: z.number(),
  page_size: z.number(),
  has_next: z.boolean(),
  ...ToolSuccessMetaShape,
}
const EnrichCompanyShape = {
  company: CompanyDetailSchema,
  ...ToolSuccessMetaShape,
}
const GetIntentShape = {
  company_id: z.string().nullable(),
  intent_topics: z.array(IntentTopicSchema),
  ...ToolSuccessMetaShape,
}
const GetOrgChartShape = {
  company_id: z.string().nullable(),
  executives: z.array(ExecutiveSummarySchema),
  ...ToolSuccessMetaShape,
}

const LICENSING_NOTE =
  "Note: ZoomInfo data is licensed. Use only to populate the user's own CRM — do not export or share externally."

export function registerTools(server: McpServer): void {
  const getConnectionStatus = wrapTool("zoominfo_get_connection_status", getConnectionStatusImpl)
  const searchContacts = wrapTool("zoominfo_search_contacts", searchContactsImpl)
  const enrichContact = wrapTool("zoominfo_enrich_contact", enrichContactImpl)
  const searchCompanies = wrapTool("zoominfo_search_companies", searchCompaniesImpl)
  const enrichCompany = wrapTool("zoominfo_enrich_company", enrichCompanyImpl)
  const getIntent = wrapTool("zoominfo_get_intent", getIntentImpl)
  const getOrgChart = wrapTool("zoominfo_get_org_chart", getOrgChartImpl)

  server.registerTool(
    "zoominfo_get_connection_status",
    {
      title: "Check ZoomInfo connection",
      description: `Check whether ZoomInfo is connected for this workspace.

When to use: ALWAYS call this first if any zoominfo_* tool returns a not_connected error, or before suggesting ZoomInfo features for the first time.
Returns: { connected: true } if linked, { connected: false } otherwise. If false, tell the user to connect ZoomInfo from the Holaboss integrations page.

${LICENSING_NOTE}`,
      inputSchema: {},
      outputSchema: ConnectionStatusShape,
      annotations: {
        title: "Check ZoomInfo connection",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => asText(await getConnectionStatus({})),
  )

  server.registerTool(
    "zoominfo_search_contacts",
    {
      title: "Search ZoomInfo contacts",
      description: `Search ZoomInfo's B2B contact database by persona criteria (job title, management level, function, geography).

When to use: prospecting — "find me 50 CMOs at fintechs in the EU".
When NOT to use: looking up a known person — use zoominfo_enrich_contact instead.
Returns: contact summaries WITHOUT email/phone (those require zoominfo_enrich_contact). Pagination is page-based: use { page, page_size } and watch has_next.

${LICENSING_NOTE}`,
      inputSchema: {
        job_titles: z
          .array(z.string())
          .optional()
          .describe("Job-title fragments to match, e.g. ['Chief Marketing Officer', 'VP Marketing']."),
        management_levels: z
          .array(z.enum(["c_level", "vp_level", "director_level", "manager_level", "non_manager"]))
          .optional()
          .describe("Seniority bucket(s), e.g. ['c_level','vp_level']."),
        job_functions: z
          .array(z.string())
          .optional()
          .describe("Functional area(s), e.g. ['marketing','sales','engineering']."),
        company_ids: z
          .array(z.string())
          .optional()
          .describe("Restrict to specific ZoomInfo company ids (from zoominfo_search_companies)."),
        company_domains: z
          .array(z.string())
          .optional()
          .describe("Restrict to companies by domain, e.g. ['acme.com']."),
        locations: z
          .array(z.string())
          .optional()
          .describe(
            "ISO geographies. Use country code ('US','GB','DE') or country-state ('US-CA','US-NY') — split on the dash.",
          ),
        page: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed page number. Default 1. Increment to paginate while has_next is true."),
        page_size: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Results per page (rpp). Default 25, max 100."),
      },
      outputSchema: SearchContactsShape,
      annotations: {
        title: "Search ZoomInfo contacts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await searchContacts(args as SearchContactsInput)),
  )

  server.registerTool(
    "zoominfo_enrich_contact",
    {
      title: "Enrich ZoomInfo contact",
      description: `Get full contact details (email, direct phone, mobile, business address, LinkedIn) for ONE person.

When to use: the user wants to actually contact someone, not just see they exist. Call after zoominfo_search_contacts to get details for a specific record.
When NOT to use: bulk fan-out across every search result — this CONSUMES CREDITS.
Inputs: provide ONE of (a) contact_id (from search), (b) email, OR (c) first_name + last_name + (company_id OR company_domain).
Returns: { contact: { id, name, email, phone, mobile, title, company, ... } }.
Errors: { code: 'not_found' } if no match. { code: 'validation_failed' } if no usable input combination is supplied.

${LICENSING_NOTE}`,
      inputSchema: {
        contact_id: z
          .string()
          .optional()
          .describe("ZoomInfo person/contact id (from zoominfo_search_contacts)."),
        email: z
          .string()
          .optional()
          .describe("Known email address, e.g. 'alice@acme.com'."),
        first_name: z.string().optional().describe("First name, e.g. 'Alice'. Must be paired with last_name + company_id/company_domain."),
        last_name: z.string().optional().describe("Last name, e.g. 'Johnson'. Must be paired with first_name + company_id/company_domain."),
        company_id: z.string().optional().describe("ZoomInfo company id of the person's employer."),
        company_domain: z
          .string()
          .optional()
          .describe("Employer domain, e.g. 'acme.com'."),
      },
      outputSchema: EnrichContactShape,
      annotations: {
        title: "Enrich ZoomInfo contact",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await enrichContact(args as EnrichContactInput)),
  )

  server.registerTool(
    "zoominfo_search_companies",
    {
      title: "Search ZoomInfo companies",
      description: `Search ZoomInfo's company database by firmographic filters (industry, headcount, revenue, geography, tech stack).

When to use: account discovery — "find me Series-B SaaS companies in California using Snowflake".
When NOT to use: looking up a known company — use zoominfo_enrich_company instead.
Returns: company summaries (name, domain, industry, headcount, revenue, country). Pagination is page-based: use { page, page_size } and watch has_next.

${LICENSING_NOTE}`,
      inputSchema: {
        industries: z
          .array(z.string())
          .optional()
          .describe("Industry name(s), e.g. ['Computer Software','Fintech']."),
        employee_count_ranges: z
          .array(z.string())
          .optional()
          .describe("Headcount band(s), e.g. ['11-50','51-200','201-500','501-1000','1001-5000','5001+']."),
        revenue_ranges: z
          .array(z.string())
          .optional()
          .describe("Annual revenue band(s), e.g. ['$1M-$10M','$10M-$50M','$50M-$100M']."),
        locations: z
          .array(z.string())
          .optional()
          .describe("ISO country code(s), e.g. ['US','GB','DE']."),
        technologies: z
          .array(z.string())
          .optional()
          .describe("Tech-stack item(s), e.g. ['Snowflake','React','AWS']."),
        page: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed page number. Default 1."),
        page_size: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Results per page (rpp). Default 25, max 100."),
      },
      outputSchema: SearchCompaniesShape,
      annotations: {
        title: "Search ZoomInfo companies",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await searchCompanies(args as SearchCompaniesInput)),
  )

  server.registerTool(
    "zoominfo_enrich_company",
    {
      title: "Enrich ZoomInfo company",
      description: `Get full company details (firmographics, tech stack, founded year, recent news, employee headcount by department) for ONE company.

When to use: the user wants depth on a specific account — "tell me everything about Acme".
Inputs: provide ONE of company_id (from search), company_domain, or company_name.
Returns: { company: { id, name, domain, industry, employee_count, revenue, technologies, employee_count_by_department, recent_news, ... } }.
Errors: { code: 'not_found' } if no match. { code: 'validation_failed' } if no input is supplied.

${LICENSING_NOTE}`,
      inputSchema: {
        company_id: z.string().optional().describe("ZoomInfo company id (from zoominfo_search_companies)."),
        company_domain: z.string().optional().describe("Company domain, e.g. 'acme.com'."),
        company_name: z.string().optional().describe("Company name, e.g. 'Acme Inc'."),
      },
      outputSchema: EnrichCompanyShape,
      annotations: {
        title: "Enrich ZoomInfo company",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await enrichCompany(args as EnrichCompanyInput)),
  )

  server.registerTool(
    "zoominfo_get_intent",
    {
      title: "Get ZoomInfo intent signals",
      description: `Get buyer intent signals for ONE company — what topics it is actively researching across the web.

When to use: qualify timing — "is this account in-market right now?".
Inputs: provide company_id OR company_domain. Optionally restrict to specific topics.
Returns: { company_id, intent_topics: [{ topic, score, trending_since }] }. Score is 0–100; topics with score > 70 indicate strong buying intent.
Errors: { code: 'not_found' } if no intent data exists for the company.

${LICENSING_NOTE}`,
      inputSchema: {
        company_id: z.string().optional().describe("ZoomInfo company id (from zoominfo_search_companies)."),
        company_domain: z.string().optional().describe("Company domain, e.g. 'globex.com'."),
        topics: z
          .array(z.string())
          .optional()
          .describe("Restrict to specific topics, e.g. ['CRM','Marketing Automation','Data Warehouse']."),
      },
      outputSchema: GetIntentShape,
      annotations: {
        title: "Get ZoomInfo intent signals",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await getIntent(args as GetIntentInput)),
  )

  server.registerTool(
    "zoominfo_get_org_chart",
    {
      title: "Get ZoomInfo org chart",
      description: `List C-suite + VP-level executives at a company. Flat list (we do not model hierarchy in v1).

When to use: identify decision-makers and their reports for a target account.
Inputs: provide company_id OR company_domain. Optionally narrow seniority via levels.
Returns: { company_id, executives: [{ id, name, title, management_level, function }] }. Use zoominfo_enrich_contact to get email/phone for any one of them.

${LICENSING_NOTE}`,
      inputSchema: {
        company_id: z.string().optional().describe("ZoomInfo company id (from zoominfo_search_companies)."),
        company_domain: z.string().optional().describe("Company domain, e.g. 'acme.com'."),
        levels: z
          .array(z.enum(["c_level", "vp_level", "director_level"]))
          .optional()
          .describe("Seniority filter. Default ['c_level','vp_level']."),
      },
      outputSchema: GetOrgChartShape,
      annotations: {
        title: "Get ZoomInfo org chart",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await getOrgChart(args as GetOrgChartInput)),
  )
}
