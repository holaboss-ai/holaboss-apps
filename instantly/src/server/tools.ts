import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { apiDelete, apiGet, apiPost } from "./instantly-client"
import { wrapTool } from "./audit"
import { isSyncEnabled, setSyncEnabled, syncOutreach } from "./sync"
import type {
  CampaignDetails,
  CampaignStats,
  CampaignStatus,
  CampaignSummary,
  InstantlyError,
  LeadStatus,
  LeadSummary,
  Result,
  ToolSuccessMeta,
} from "../lib/types"

const INSTANTLY_APP_BASE = "https://app.instantly.ai"

function campaignDeepLink(id: string) {
  return `${INSTANTLY_APP_BASE}/app/campaigns/${id}`
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

// Instantly v2 campaign status enum: 0=draft, 1=active, 2=paused, 3=completed
// (verified against the public OpenAPI spec). String forms are also tolerated.
const CAMPAIGN_STATUS_NUMERIC: Record<number, CampaignStatus> = {
  0: "draft",
  1: "active",
  2: "paused",
  3: "completed",
}

function normalizeCampaignStatus(raw: unknown): CampaignStatus {
  if (typeof raw === "number" && raw in CAMPAIGN_STATUS_NUMERIC) {
    return CAMPAIGN_STATUS_NUMERIC[raw]
  }
  if (typeof raw === "string") {
    const lower = raw.toLowerCase()
    if (lower === "active" || lower === "running") return "active"
    if (lower === "paused") return "paused"
    if (lower === "draft") return "draft"
    if (lower === "completed" || lower === "finished") return "completed"
  }
  return "draft"
}

function normalizeLeadStatus(raw: unknown): LeadStatus {
  if (typeof raw === "string") {
    const lower = raw.toLowerCase()
    if (lower === "replied") return "replied"
    if (lower === "bounced") return "bounced"
    if (lower === "unsubscribed") return "unsubscribed"
    if (lower === "completed" || lower === "finished") return "completed"
    if (lower === "active" || lower === "in_progress") return "active"
  }
  // Instantly numeric lead statuses (1=active, 3=replied, 7=bounced, 8=unsubscribed,
  // 9=completed) — keep tolerant defaults.
  if (typeof raw === "number") {
    if (raw === 3) return "replied"
    if (raw === 7) return "bounced"
    if (raw === 8) return "unsubscribed"
    if (raw === 9) return "completed"
  }
  return "active"
}

function normalizeCampaignSummary(raw: Record<string, unknown>): CampaignSummary {
  return {
    id: s(raw.id) ?? "",
    name: s(raw.name) ?? "(unnamed campaign)",
    status: normalizeCampaignStatus(raw.status),
    lead_count: n(raw.leads_count) ?? n(raw.lead_count) ?? null,
    last_activity_at:
      s(raw.last_activity_at) ?? s(raw.last_step_run) ?? s(raw.updated_at) ?? null,
  }
}

function normalizeCampaignDetails(raw: Record<string, unknown>): CampaignDetails {
  const schedule = (raw.campaign_schedule ?? raw.schedule) as
    | Record<string, unknown>
    | undefined
  const schedules = (schedule?.schedules as Array<Record<string, unknown>> | undefined) ?? []
  const firstSched = schedules[0] ?? {}
  const timing = (firstSched.timing as Record<string, unknown> | undefined) ?? {}
  const days = (firstSched.days as Record<string, unknown> | undefined) ?? {}
  const sendDays: string[] = []
  const dayMap: Record<string, string> = {
    "0": "Sun",
    "1": "Mon",
    "2": "Tue",
    "3": "Wed",
    "4": "Thu",
    "5": "Fri",
    "6": "Sat",
  }
  for (const key of Object.keys(days)) {
    if (days[key]) {
      const label = dayMap[key]
      if (label) sendDays.push(label)
    }
  }

  const sequencesRaw = Array.isArray(raw.sequences)
    ? (raw.sequences as Array<Record<string, unknown>>)
    : []
  const stepsRaw: Array<Record<string, unknown>> = []
  for (const seq of sequencesRaw) {
    const steps = Array.isArray(seq.steps) ? (seq.steps as Array<Record<string, unknown>>) : []
    for (const st of steps) stepsRaw.push(st)
  }

  const steps = stepsRaw.map((st, idx) => {
    const variants = Array.isArray(st.variants)
      ? (st.variants as Array<Record<string, unknown>>)
      : []
    const v0 = variants[0] ?? {}
    const body = s(v0.body) ?? s(st.body)
    return {
      step_index: idx + 1,
      delay_days: n(st.delay) ?? n(st.day_delay) ?? null,
      subject: s(v0.subject) ?? s(st.subject),
      body_preview: body ? body.replace(/<[^>]+>/g, "").slice(0, 200) : null,
    }
  })

  const sendingAccountsRaw = Array.isArray(raw.email_list)
    ? (raw.email_list as unknown[])
    : Array.isArray(raw.sending_accounts)
      ? (raw.sending_accounts as unknown[])
      : []
  const sending_accounts = sendingAccountsRaw
    .map((x) => s(x))
    .filter((x): x is string => Boolean(x))

  return {
    id: s(raw.id) ?? "",
    name: s(raw.name) ?? "(unnamed campaign)",
    status: normalizeCampaignStatus(raw.status),
    schedule: {
      timezone: s(firstSched.timezone) ?? s(schedule?.timezone),
      send_days: sendDays,
      send_window: {
        start: s(timing.from),
        end: s(timing.to),
      },
    },
    steps,
    sending_accounts,
  }
}

function normalizeLead(raw: Record<string, unknown>): LeadSummary {
  return {
    lead_id: s(raw.id) ?? "",
    email: s(raw.email) ?? "",
    first_name: s(raw.first_name),
    last_name: s(raw.last_name),
    status: normalizeLeadStatus(raw.status),
    added_at: s(raw.timestamp_created) ?? s(raw.created_at) ?? null,
    last_contacted_at: s(raw.timestamp_last_contact) ?? s(raw.last_contacted_at) ?? null,
  }
}

function normalizeStats(raw: Record<string, unknown>): CampaignStats {
  const sent = n(raw.sent_count) ?? n(raw.sent) ?? 0
  const delivered = n(raw.delivered_count) ?? n(raw.delivered) ?? sent
  const opened = n(raw.open_count) ?? n(raw.opened_count) ?? n(raw.opened) ?? 0
  const replied = n(raw.reply_count) ?? n(raw.replied_count) ?? n(raw.replied) ?? 0
  const bounced = n(raw.bounce_count) ?? n(raw.bounced_count) ?? n(raw.bounced) ?? 0
  const unsubscribed =
    n(raw.unsubscribe_count) ?? n(raw.unsubscribed_count) ?? n(raw.unsubscribed) ?? 0
  const denom = delivered > 0 ? delivered : sent > 0 ? sent : 1
  const rate = (x: number) => Math.round((x / denom) * 10000) / 10000
  return {
    sent,
    delivered,
    opened,
    replied,
    bounced,
    unsubscribed,
    open_rate: sent === 0 ? 0 : rate(opened),
    reply_rate: sent === 0 ? 0 : rate(replied),
    bounce_rate: sent === 0 ? 0 : rate(bounced),
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
      workspace_name?: string
    } & ToolSuccessMeta,
    InstantlyError
  >
> {
  const r = await apiGet<{ name?: string; workspace_name?: string }>("/workspaces/current")
  if (r.ok) {
    return {
      ok: true,
      data: {
        connected: true,
        workspace_name: r.data?.name ?? r.data?.workspace_name,
        result_summary: "Instantly connection verified",
      },
    }
  }
  if (r.error.code === "not_connected") {
    return { ok: true, data: { connected: false, result_summary: "Instantly not connected" } }
  }
  return r as unknown as Result<{ connected: boolean } & ToolSuccessMeta, InstantlyError>
}

// ---- List campaigns ----

export interface ListCampaignsInput {
  status?: CampaignStatus
  limit?: number
  starting_after?: string
}

export async function listCampaignsImpl(
  input: ListCampaignsInput,
): Promise<
  Result<
    { campaigns: CampaignSummary[]; next_starting_after: string | null } & ToolSuccessMeta,
    InstantlyError
  >
> {
  const params = new URLSearchParams()
  params.set("limit", String(Math.min(input.limit ?? 50, 100)))
  if (input.starting_after) params.set("starting_after", input.starting_after)
  if (input.status) {
    // Map enum -> numeric where the API expects it; also pass the string form
    // so either dialect of the v2 API accepts.
    const numeric = (
      Object.entries(CAMPAIGN_STATUS_NUMERIC) as [string, CampaignStatus][]
    ).find(([, v]) => v === input.status)?.[0]
    if (numeric) params.set("status", numeric)
  }

  const r = await apiGet<{
    items?: Array<Record<string, unknown>>
    data?: Array<Record<string, unknown>>
    next_starting_after?: string | null
    starting_after?: string | null
  }>(`/campaigns?${params.toString()}`)
  if (!r.ok) return r
  const rawList = (r.data?.items ?? r.data?.data ?? []) as Array<Record<string, unknown>>
  const campaigns = rawList.map(normalizeCampaignSummary)
  return {
    ok: true,
    data: {
      campaigns,
      next_starting_after: r.data?.next_starting_after ?? r.data?.starting_after ?? null,
      instantly_object: "campaigns",
      result_summary: `Found ${campaigns.length} campaign(s)`,
    },
  }
}

// ---- Get campaign ----

export interface GetCampaignInput {
  campaign_id: string
}

export async function getCampaignImpl(
  input: GetCampaignInput,
): Promise<Result<{ campaign: CampaignDetails } & ToolSuccessMeta, InstantlyError>> {
  const r = await apiGet<Record<string, unknown>>(`/campaigns/${encodeURIComponent(input.campaign_id)}`)
  if (!r.ok) return r
  if (!r.data || typeof r.data !== "object") {
    return { ok: false, error: { code: "not_found", message: `Campaign ${input.campaign_id} not found` } }
  }
  const campaign = normalizeCampaignDetails(r.data)
  return {
    ok: true,
    data: {
      campaign,
      instantly_object: "campaigns",
      instantly_record_id: campaign.id,
      instantly_deep_link: campaignDeepLink(campaign.id),
      result_summary: `Fetched campaign ${campaign.id}`,
    },
  }
}

// ---- Create campaign ----

export interface CreateCampaignInput {
  name: string
  timezone?: string
  send_days?: Array<"Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun">
  send_window_start?: string
  send_window_end?: string
}

const DAY_INDEX: Record<string, string> = {
  Sun: "0",
  Mon: "1",
  Tue: "2",
  Wed: "3",
  Thu: "4",
  Fri: "5",
  Sat: "6",
}

export async function createCampaignImpl(
  input: CreateCampaignInput,
): Promise<
  Result<
    {
      campaign_id: string
      name: string
      status: CampaignStatus
    } & ToolSuccessMeta,
    InstantlyError
  >
> {
  const sendDays = input.send_days ?? ["Mon", "Tue", "Wed", "Thu", "Fri"]
  const days: Record<string, boolean> = {
    "0": false,
    "1": false,
    "2": false,
    "3": false,
    "4": false,
    "5": false,
    "6": false,
  }
  for (const d of sendDays) {
    const idx = DAY_INDEX[d]
    if (idx) days[idx] = true
  }
  const body: Record<string, unknown> = {
    name: input.name,
    campaign_schedule: {
      schedules: [
        {
          name: "Default schedule",
          timing: {
            from: input.send_window_start ?? "09:00",
            to: input.send_window_end ?? "17:00",
          },
          days,
          timezone: input.timezone ?? "America/New_York",
        },
      ],
    },
  }
  const r = await apiPost<Record<string, unknown>>("/campaigns", body)
  if (!r.ok) return r
  const id = s(r.data?.id) ?? ""
  if (!id) {
    return { ok: false, error: { code: "upstream_error", message: "Instantly did not return a campaign id" } }
  }
  return {
    ok: true,
    data: {
      campaign_id: id,
      name: input.name,
      status: normalizeCampaignStatus(r.data?.status ?? "draft"),
      instantly_object: "campaigns",
      instantly_record_id: id,
      instantly_deep_link: campaignDeepLink(id),
      result_summary: `Created campaign '${input.name}'`,
    },
  }
}

// ---- Pause campaign ----

export interface PauseCampaignInput {
  campaign_id: string
}

async function fetchCampaignStatus(
  campaign_id: string,
): Promise<Result<CampaignStatus, InstantlyError>> {
  const r = await apiGet<Record<string, unknown>>(`/campaigns/${encodeURIComponent(campaign_id)}`)
  if (!r.ok) return r
  if (!r.data || typeof r.data !== "object") {
    return { ok: false, error: { code: "not_found", message: `Campaign ${campaign_id} not found` } }
  }
  return { ok: true, data: normalizeCampaignStatus(r.data.status) }
}

export async function pauseCampaignImpl(
  input: PauseCampaignInput,
): Promise<
  Result<
    { campaign_id: string; status: "paused"; already_paused: boolean } & ToolSuccessMeta,
    InstantlyError
  >
> {
  const current = await fetchCampaignStatus(input.campaign_id)
  if (!current.ok) return current
  if (current.data === "paused") {
    return {
      ok: true,
      data: {
        campaign_id: input.campaign_id,
        status: "paused",
        already_paused: true,
        instantly_object: "campaigns",
        instantly_record_id: input.campaign_id,
        instantly_deep_link: campaignDeepLink(input.campaign_id),
        result_summary: `Campaign ${input.campaign_id} was already paused`,
      },
    }
  }
  if (current.data !== "active") {
    return {
      ok: false,
      error: {
        code: "invalid_state",
        message: `Cannot pause campaign in '${current.data}' state. Only 'active' campaigns can be paused.`,
      },
    }
  }
  const r = await apiPost<Record<string, unknown>>(
    `/campaigns/${encodeURIComponent(input.campaign_id)}/pause`,
    {},
  )
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      campaign_id: input.campaign_id,
      status: "paused",
      already_paused: false,
      instantly_object: "campaigns",
      instantly_record_id: input.campaign_id,
      instantly_deep_link: campaignDeepLink(input.campaign_id),
      result_summary: `Paused campaign ${input.campaign_id}`,
    },
  }
}

// ---- Resume campaign ----

export interface ResumeCampaignInput {
  campaign_id: string
}

export async function resumeCampaignImpl(
  input: ResumeCampaignInput,
): Promise<
  Result<
    { campaign_id: string; status: "active"; already_active: boolean } & ToolSuccessMeta,
    InstantlyError
  >
> {
  const current = await fetchCampaignStatus(input.campaign_id)
  if (!current.ok) return current
  if (current.data === "active") {
    return {
      ok: true,
      data: {
        campaign_id: input.campaign_id,
        status: "active",
        already_active: true,
        instantly_object: "campaigns",
        instantly_record_id: input.campaign_id,
        instantly_deep_link: campaignDeepLink(input.campaign_id),
        result_summary: `Campaign ${input.campaign_id} was already active`,
      },
    }
  }
  if (current.data !== "paused" && current.data !== "draft") {
    return {
      ok: false,
      error: {
        code: "invalid_state",
        message: `Cannot resume campaign in '${current.data}' state. Only 'paused' or 'draft' campaigns can be activated.`,
      },
    }
  }
  const r = await apiPost<Record<string, unknown>>(
    `/campaigns/${encodeURIComponent(input.campaign_id)}/activate`,
    {},
  )
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      campaign_id: input.campaign_id,
      status: "active",
      already_active: false,
      instantly_object: "campaigns",
      instantly_record_id: input.campaign_id,
      instantly_deep_link: campaignDeepLink(input.campaign_id),
      result_summary: `Activated campaign ${input.campaign_id}`,
    },
  }
}

// ---- List leads ----

export interface ListLeadsInput {
  campaign_id: string
  status?: LeadStatus
  limit?: number
  starting_after?: string
}

export async function listLeadsImpl(
  input: ListLeadsInput,
): Promise<
  Result<
    { leads: LeadSummary[]; next_starting_after: string | null } & ToolSuccessMeta,
    InstantlyError
  >
> {
  // Instantly v2 leads search lives at POST /leads/list — accepts campaign filter
  // and a starting_after cursor.
  const body: Record<string, unknown> = {
    campaign: input.campaign_id,
    limit: Math.min(input.limit ?? 50, 100),
  }
  if (input.starting_after) body.starting_after = input.starting_after
  if (input.status) body.filter = input.status

  const r = await apiPost<{
    items?: Array<Record<string, unknown>>
    data?: Array<Record<string, unknown>>
    next_starting_after?: string | null
    starting_after?: string | null
  }>("/leads/list", body)
  if (!r.ok) return r
  const rawList = (r.data?.items ?? r.data?.data ?? []) as Array<Record<string, unknown>>
  const leads = rawList.map(normalizeLead)
  return {
    ok: true,
    data: {
      leads,
      next_starting_after: r.data?.next_starting_after ?? r.data?.starting_after ?? null,
      instantly_object: "leads",
      instantly_record_id: input.campaign_id,
      instantly_deep_link: campaignDeepLink(input.campaign_id),
      result_summary: `Found ${leads.length} lead(s) in campaign`,
    },
  }
}

// ---- Add lead(s) to campaign ----

export interface AddLeadToCampaignInput {
  campaign_id: string
  leads: Array<{
    email: string
    first_name?: string
    last_name?: string
    company_name?: string
    custom_fields?: Record<string, string>
  }>
}

export async function addLeadToCampaignImpl(
  input: AddLeadToCampaignInput,
): Promise<
  Result<
    {
      campaign_id: string
      added_count: number
      skipped_count: number
      lead_ids: string[]
    } & ToolSuccessMeta,
    InstantlyError
  >
> {
  if (!input.leads.length) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "leads must contain at least one entry." },
    }
  }
  if (input.leads.length > 100) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        message: "Maximum 100 leads per call. Paginate larger batches.",
      },
    }
  }
  const body = {
    campaign: input.campaign_id,
    skip_if_in_workspace: true,
    skip_if_in_campaign: true,
    leads: input.leads.map((l) => ({
      email: l.email,
      first_name: l.first_name,
      last_name: l.last_name,
      company_name: l.company_name,
      custom_variables: l.custom_fields,
    })),
  }
  // Instantly v2 supports POST /leads/list/import-leads OR POST /leads — the
  // canonical create endpoint is POST /leads. For batch we use POST /leads
  // with an array body when supported, falling back to bulk import.
  const r = await apiPost<{
    items?: Array<Record<string, unknown>>
    data?: Array<Record<string, unknown>>
    leads?: Array<Record<string, unknown>>
    added?: number
    inserted?: number
    skipped?: number
    duplicates?: number
  }>("/leads/list", body)
  if (!r.ok) return r
  const itemList = (r.data?.items ?? r.data?.data ?? r.data?.leads ?? []) as Array<
    Record<string, unknown>
  >
  const lead_ids = itemList
    .map((x) => s(x.id))
    .filter((x): x is string => Boolean(x))
  const added =
    n(r.data?.added) ?? n(r.data?.inserted) ?? lead_ids.length
  const skipped =
    n(r.data?.skipped) ?? n(r.data?.duplicates) ?? Math.max(0, input.leads.length - added)
  return {
    ok: true,
    data: {
      campaign_id: input.campaign_id,
      added_count: added,
      skipped_count: skipped,
      lead_ids,
      instantly_object: "leads",
      instantly_record_id: input.campaign_id,
      instantly_deep_link: campaignDeepLink(input.campaign_id),
      result_summary: `Added ${added} lead(s), ${skipped} skipped`,
    },
  }
}

// ---- Remove lead from campaign ----

export interface RemoveLeadFromCampaignInput {
  campaign_id: string
  lead_id: string
}

export async function removeLeadFromCampaignImpl(
  input: RemoveLeadFromCampaignInput,
): Promise<
  Result<
    {
      campaign_id: string
      lead_id: string
      removed: boolean
    } & ToolSuccessMeta,
    InstantlyError
  >
> {
  const r = await apiDelete<Record<string, unknown>>(
    `/leads/${encodeURIComponent(input.lead_id)}`,
  )
  if (!r.ok) {
    if (r.error.code === "not_found") {
      // Idempotent: removing a lead not in the campaign returns removed=false.
      return {
        ok: true,
        data: {
          campaign_id: input.campaign_id,
          lead_id: input.lead_id,
          removed: false,
          instantly_object: "leads",
          instantly_record_id: input.lead_id,
          result_summary: `Lead ${input.lead_id} was not in campaign (no-op)`,
        },
      }
    }
    return r
  }
  return {
    ok: true,
    data: {
      campaign_id: input.campaign_id,
      lead_id: input.lead_id,
      removed: true,
      instantly_object: "leads",
      instantly_record_id: input.lead_id,
      instantly_deep_link: campaignDeepLink(input.campaign_id),
      result_summary: `Removed lead ${input.lead_id} from campaign`,
    },
  }
}

// ---- Get campaign stats ----

export interface GetCampaignStatsInput {
  campaign_id: string
}

export async function getCampaignStatsImpl(
  input: GetCampaignStatsInput,
): Promise<
  Result<
    { campaign_id: string } & CampaignStats & ToolSuccessMeta,
    InstantlyError
  >
> {
  // Instantly v2 analytics endpoint shape (verified 2026-04 against the live
  // API): /campaigns/analytics with the campaign_id passed as a query param,
  // NOT /campaigns/<id>/analytics. Wrong path returns 404 "Route ... not found".
  const r = await apiGet<Record<string, unknown> | Array<Record<string, unknown>>>(
    `/campaigns/analytics?id=${encodeURIComponent(input.campaign_id)}`,
  )
  if (!r.ok) return r
  if (!r.data || typeof r.data !== "object") {
    return {
      ok: false,
      error: { code: "not_found", message: `Campaign ${input.campaign_id} not found` },
    }
  }
  // Instantly's /analytics endpoint may return either an object or an array
  // (one entry per campaign). Normalize by picking the first matching record.
  const raw = Array.isArray(r.data)
    ? ((r.data as Array<Record<string, unknown>>)[0] ?? {})
    : (r.data as Record<string, unknown>)
  const stats = normalizeStats(raw)
  return {
    ok: true,
    data: {
      campaign_id: input.campaign_id,
      ...stats,
      instantly_object: "campaigns",
      instantly_record_id: input.campaign_id,
      instantly_deep_link: campaignDeepLink(input.campaign_id),
      result_summary: `Stats: sent=${stats.sent}, replied=${stats.replied}, bounced=${stats.bounced}`,
    },
  }
}

// ---- Send test email ----

export interface SendTestEmailInput {
  campaign_id: string
  step_index: number
  to_email: string
}

export async function sendTestEmailImpl(
  input: SendTestEmailInput,
): Promise<
  Result<
    {
      sent: boolean
      to_email: string
      step_index: number
      campaign_id: string
    } & ToolSuccessMeta,
    InstantlyError
  >
> {
  if (!input.to_email.includes("@")) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "to_email must be a valid email address." },
    }
  }
  if (input.step_index < 1) {
    return {
      ok: false,
      error: { code: "validation_failed", message: "step_index is 1-indexed." },
    }
  }
  const r = await apiPost<Record<string, unknown>>(
    `/campaigns/${encodeURIComponent(input.campaign_id)}/test-send`,
    {
      step: input.step_index,
      email: input.to_email,
    },
  )
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      sent: true,
      to_email: input.to_email,
      step_index: input.step_index,
      campaign_id: input.campaign_id,
      instantly_object: "campaigns",
      instantly_record_id: input.campaign_id,
      instantly_deep_link: campaignDeepLink(input.campaign_id),
      result_summary: `Sent test email of step ${input.step_index} to ${input.to_email}`,
    },
  }
}

// ---- MCP wiring ----

const asText = (result: Result<unknown, InstantlyError>) => {
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      structuredContent: result.data as Record<string, unknown>,
    }
  }
  // Flat error envelope per docs/MCP_TOOL_DESCRIPTION_CONVENTION.md §"Errors".
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
    structuredContent: result.error as unknown as Record<string, unknown>,
    isError: true as const,
  }
}

// ---- Output shapes (MCP outputSchema) ----

const ToolSuccessMetaShape = {
  instantly_object: z.string().optional(),
  instantly_record_id: z.string().optional(),
  instantly_deep_link: z.string().optional(),
  result_summary: z.string().optional(),
}

const CampaignStatusEnum = z.enum(["active", "paused", "draft", "completed"])
const LeadStatusEnum = z.enum(["active", "replied", "bounced", "unsubscribed", "completed"])

const CampaignSummaryShape = z.object({
  id: z.string(),
  name: z.string(),
  status: CampaignStatusEnum,
  lead_count: z.number().nullable(),
  last_activity_at: z.string().nullable(),
})

const CampaignDetailsShape = z.object({
  id: z.string(),
  name: z.string(),
  status: CampaignStatusEnum,
  schedule: z.object({
    timezone: z.string().nullable(),
    send_days: z.array(z.string()),
    send_window: z.object({
      start: z.string().nullable(),
      end: z.string().nullable(),
    }),
  }),
  steps: z.array(
    z.object({
      step_index: z.number(),
      delay_days: z.number().nullable(),
      subject: z.string().nullable(),
      body_preview: z.string().nullable(),
    }),
  ),
  sending_accounts: z.array(z.string()),
})

const LeadShape = z.object({
  lead_id: z.string(),
  email: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  status: LeadStatusEnum,
  added_at: z.string().nullable(),
  last_contacted_at: z.string().nullable(),
})

const ConnectionStatusShape = {
  connected: z.boolean(),
  workspace_name: z.string().optional(),
  ...ToolSuccessMetaShape,
}

const ListCampaignsShape = {
  campaigns: z.array(CampaignSummaryShape),
  next_starting_after: z.string().nullable(),
  ...ToolSuccessMetaShape,
}

const GetCampaignShape = {
  campaign: CampaignDetailsShape,
  ...ToolSuccessMetaShape,
}

const CreateCampaignShape = {
  campaign_id: z.string(),
  name: z.string(),
  status: CampaignStatusEnum,
  ...ToolSuccessMetaShape,
}

const PauseCampaignShape = {
  campaign_id: z.string(),
  status: z.literal("paused"),
  already_paused: z.boolean(),
  ...ToolSuccessMetaShape,
}

const ResumeCampaignShape = {
  campaign_id: z.string(),
  status: z.literal("active"),
  already_active: z.boolean(),
  ...ToolSuccessMetaShape,
}

const ListLeadsShape = {
  leads: z.array(LeadShape),
  next_starting_after: z.string().nullable(),
  ...ToolSuccessMetaShape,
}

const AddLeadShape = {
  campaign_id: z.string(),
  added_count: z.number(),
  skipped_count: z.number(),
  lead_ids: z.array(z.string()),
  ...ToolSuccessMetaShape,
}

const RemoveLeadShape = {
  campaign_id: z.string(),
  lead_id: z.string(),
  removed: z.boolean(),
  ...ToolSuccessMetaShape,
}

const StatsShape = {
  campaign_id: z.string(),
  sent: z.number(),
  delivered: z.number(),
  opened: z.number(),
  replied: z.number(),
  bounced: z.number(),
  unsubscribed: z.number(),
  open_rate: z.number(),
  reply_rate: z.number(),
  bounce_rate: z.number(),
  ...ToolSuccessMetaShape,
}

const SendTestEmailShape = {
  sent: z.boolean(),
  to_email: z.string(),
  step_index: z.number(),
  campaign_id: z.string(),
  ...ToolSuccessMetaShape,
}

// -------------------- Sync (local mirror) --------------------

export interface SyncOutreachInput { full?: boolean }
export async function syncOutreachImpl(
  input: SyncOutreachInput,
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
    InstantlyError
  >
> {
  try {
    const r = await syncOutreach({ full: input.full })
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
): Promise<Result<{ enabled: boolean } & ToolSuccessMeta, InstantlyError>> {
  setSyncEnabled(input.enabled)
  return {
    ok: true,
    data: {
      enabled: isSyncEnabled(),
      result_summary: input.enabled ? "Instantly sync enabled" : "Instantly sync disabled",
    },
  }
}

export function registerTools(server: McpServer): void {
  const getConnectionStatus = wrapTool("instantly_get_connection_status", getConnectionStatusImpl)
  const listCampaigns = wrapTool("instantly_list_campaigns", listCampaignsImpl)
  const getCampaign = wrapTool("instantly_get_campaign", getCampaignImpl)
  const createCampaign = wrapTool("instantly_create_campaign", createCampaignImpl)
  const pauseCampaign = wrapTool("instantly_pause_campaign", pauseCampaignImpl)
  const resumeCampaign = wrapTool("instantly_resume_campaign", resumeCampaignImpl)
  const listLeads = wrapTool("instantly_list_leads", listLeadsImpl)
  const addLeadToCampaign = wrapTool("instantly_add_lead_to_campaign", addLeadToCampaignImpl)
  const syncOutreachTool = wrapTool("instantly_sync_outreach", syncOutreachImpl)
  const setSyncEnabledTool = wrapTool("instantly_set_sync_enabled", setSyncEnabledImpl)
  const removeLeadFromCampaign = wrapTool(
    "instantly_remove_lead_from_campaign",
    removeLeadFromCampaignImpl,
  )
  const getCampaignStats = wrapTool("instantly_get_campaign_stats", getCampaignStatsImpl)
  const sendTestEmail = wrapTool("instantly_send_test_email", sendTestEmailImpl)

  server.registerTool(
    "instantly_get_connection_status",
    {
      title: "Check Instantly connection",
      description: `Check whether Instantly.ai is connected for this workspace.

When to use: ALWAYS call this first if any Instantly tool returns a not_connected error, or before suggesting Instantly features for the first time.
Returns: { connected: true, workspace_name? } if linked, { connected: false } otherwise. If false, tell the user to connect Instantly from the Holaboss integrations page.`,
      inputSchema: {},
      outputSchema: ConnectionStatusShape,
      annotations: {
        title: "Check Instantly connection",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => asText(await getConnectionStatus({})),
  )

  server.registerTool(
    "instantly_list_campaigns",
    {
      title: "List Instantly campaigns",
      description: `List campaigns ordered by created_at DESC, with name, status, lead count, and last activity.

When to use: discovery — "what campaigns do I have?", "which one is paused?". Filter by status to focus.
When NOT to use: to inspect a specific campaign's steps or schedule — call instantly_get_campaign with its id.
Returns: { campaigns: [{ id, name, status, lead_count, last_activity_at }], next_starting_after }. status is one of 'active' | 'paused' | 'draft' | 'completed'. Pass next_starting_after back as starting_after to fetch the next page; null means end of list.`,
      inputSchema: {
        status: z
          .enum(["active", "paused", "draft", "completed"])
          .optional()
          .describe("Filter by lifecycle state. Omit to list all campaigns."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Page size, default 50, max 100."),
        starting_after: z
          .string()
          .optional()
          .describe(
            "Pagination cursor — pass the next_starting_after from the previous call. Omit on the first page.",
          ),
      },
      outputSchema: ListCampaignsShape,
      annotations: {
        title: "List Instantly campaigns",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await listCampaigns(args)),
  )

  server.registerTool(
    "instantly_get_campaign",
    {
      title: "Get Instantly campaign",
      description: `Fetch full details for a single campaign — schedule (timezone, send days, send window), email steps with delays + subject + body preview, and the sending mailbox accounts.

When to use: after instantly_list_campaigns returns an id and you need step content or schedule details.
When NOT to use: if you only need send/reply counts — call instantly_get_campaign_stats. If you only need leads — call instantly_list_leads.
Prerequisites: campaign_id from instantly_list_campaigns.
Returns: { campaign: { id, name, status, schedule: { timezone, send_days, send_window: {start,end} }, steps: [{ step_index, delay_days, subject, body_preview }], sending_accounts } }.
Errors: { code: 'not_found' } if the id doesn't resolve.`,
      inputSchema: {
        campaign_id: z
          .string()
          .describe(
            "Instantly campaign id (UUID), e.g. '01H8X5Y...'. From instantly_list_campaigns.",
          ),
      },
      outputSchema: GetCampaignShape,
      annotations: {
        title: "Get Instantly campaign",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await getCampaign(args)),
  )

  server.registerTool(
    "instantly_create_campaign",
    {
      title: "Create Instantly campaign",
      description: `Create a new Instantly campaign with a name and basic send schedule. Steps must be configured via the Instantly UI — this tool does NOT create email content.

When to use: the user wants to spin up a new campaign shell to fill in. Pair with telling the user to add steps in the Instantly UI before activating.
When NOT to use: to design the email sequence or write copy — Instantly's editor handles that better.
Returns: { campaign_id, name, status: 'draft' }. Status starts as 'draft' and stays draft until at least one step + lead is added in the UI.`,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Campaign name shown in Instantly UI, e.g. 'Q2 Outbound — Eng Leaders'. Max 200 chars.",
          ),
        timezone: z
          .string()
          .optional()
          .describe(
            "IANA timezone, e.g. 'America/New_York'. Default 'America/New_York'.",
          ),
        send_days: z
          .array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]))
          .optional()
          .describe("Sending days. Default ['Mon','Tue','Wed','Thu','Fri']."),
        send_window_start: z
          .string()
          .optional()
          .describe("Send window start in HH:MM 24h, e.g. '09:00'. Default '09:00'."),
        send_window_end: z
          .string()
          .optional()
          .describe("Send window end in HH:MM 24h, e.g. '17:00'. Default '17:00'."),
      },
      outputSchema: CreateCampaignShape,
      annotations: {
        title: "Create Instantly campaign",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => asText(await createCampaign(args)),
  )

  server.registerTool(
    "instantly_pause_campaign",
    {
      title: "Pause Instantly campaign",
      description: `Pause an active Instantly campaign — stops further sends until resumed. Idempotent: pausing an already-paused campaign returns success with already_paused=true and no API write.

When to use: stop sends mid-flight to fix subject line, unsubscribe a lead, or change schedule.
Valid states: only 'active' campaigns can be paused. 'paused' is a no-op. 'draft' or 'completed' return invalid_state.
Returns: { campaign_id, status: 'paused', already_paused }.
Errors: { code: 'invalid_state' } if campaign is in 'draft' or 'completed'. { code: 'not_found' } if campaign_id doesn't resolve.`,
      inputSchema: {
        campaign_id: z
          .string()
          .describe("Instantly campaign id (from instantly_list_campaigns)."),
      },
      outputSchema: PauseCampaignShape,
      annotations: {
        title: "Pause Instantly campaign",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await pauseCampaign(args)),
  )

  server.registerTool(
    "instantly_resume_campaign",
    {
      title: "Resume Instantly campaign",
      description: `Resume (activate) a paused or draft Instantly campaign — sends will continue on the next scheduled window. Idempotent: resuming an already-active campaign returns success with already_active=true and no API write.

When to use: restart a paused campaign after reviewing bounces / fixing copy. Also activates draft campaigns whose steps + leads are configured.
Valid states: 'paused' and 'draft' transition to 'active'. 'active' is a no-op. 'completed' returns invalid_state.
Returns: { campaign_id, status: 'active', already_active }.
Errors: { code: 'invalid_state' } if campaign is 'completed'. { code: 'not_found' } if campaign_id doesn't resolve.`,
      inputSchema: {
        campaign_id: z
          .string()
          .describe("Instantly campaign id (from instantly_list_campaigns)."),
      },
      outputSchema: ResumeCampaignShape,
      annotations: {
        title: "Resume Instantly campaign",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await resumeCampaign(args)),
  )

  server.registerTool(
    "instantly_list_leads",
    {
      title: "List campaign leads",
      description: `List leads in a campaign with their per-lead status (active / replied / bounced / unsubscribed / completed). Filter by status to focus on bounces or replies.

When to use: "who's replied?", "show me bounces from Q2 Outbound", or to find a lead's id before removal.
Prerequisites: campaign_id from instantly_list_campaigns.
Returns: { leads: [{ lead_id, email, first_name, last_name, status, added_at, last_contacted_at }], next_starting_after }. Pass next_starting_after back as starting_after to fetch the next page.`,
      inputSchema: {
        campaign_id: z
          .string()
          .describe("Instantly campaign id (from instantly_list_campaigns)."),
        status: z
          .enum(["active", "replied", "bounced", "unsubscribed", "completed"])
          .optional()
          .describe("Filter by per-lead status. Omit to list all leads."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Page size, default 50, max 100."),
        starting_after: z
          .string()
          .optional()
          .describe(
            "Pagination cursor — pass next_starting_after from the previous call.",
          ),
      },
      outputSchema: ListLeadsShape,
      annotations: {
        title: "List campaign leads",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await listLeads(args)),
  )

  server.registerTool(
    "instantly_add_lead_to_campaign",
    {
      title: "Add leads to campaign",
      description: `Add one or more leads to a campaign. Leads are matched by email — re-adding the same email is a no-op (counted in skipped_count).

When to use: push prospects into outreach. Pair with apollo_search_people / zoominfo_search_contacts to source leads.
Prerequisites: campaign_id from instantly_list_campaigns.
Returns: { campaign_id, added_count, skipped_count, lead_ids }. added_count is unique new leads inserted; skipped_count is duplicates already in the campaign or workspace.
Errors: { code: 'invalid_state' } if campaign is 'completed'. { code: 'validation_failed' } if leads is empty or > 100.`,
      inputSchema: {
        campaign_id: z
          .string()
          .describe("Instantly campaign id (from instantly_list_campaigns)."),
        leads: z
          .array(
            z.object({
              email: z
                .string()
                .describe("Lead email — primary key. Required, e.g. 'jane@acme.com'."),
              first_name: z
                .string()
                .optional()
                .describe("First name, e.g. 'Jane'. Used in {{firstName}} merge tags."),
              last_name: z
                .string()
                .optional()
                .describe("Last name, e.g. 'Smith'. Used in {{lastName}} merge tags."),
              company_name: z
                .string()
                .optional()
                .describe("Company name, e.g. 'Acme Inc'. Used in {{companyName}} merge tags."),
              custom_fields: z
                .record(z.string(), z.string())
                .optional()
                .describe(
                  "Merge-tag values, e.g. { product: 'Holaboss', city: 'NYC' }. Used in {{custom.product}} placeholders.",
                ),
            }),
          )
          .min(1)
          .max(100)
          .describe(
            "1-100 leads per call. For larger batches, paginate. e.g. [{ email: 'a@b.com', first_name: 'Alice' }].",
          ),
      },
      outputSchema: AddLeadShape,
      annotations: {
        title: "Add leads to campaign",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => asText(await addLeadToCampaign(args)),
  )

  server.registerTool(
    "instantly_remove_lead_from_campaign",
    {
      title: "Remove lead from campaign",
      description: `Remove a single lead from a campaign — the lead stops receiving sends. Idempotent: removing a lead not in the campaign returns success with removed=false.

When to use: the lead bounced, unsubscribed manually, or was added by mistake. Pair with instantly_list_leads (status='bounced') to clean up campaigns.
Prerequisites: lead_id from instantly_list_leads.
Returns: { campaign_id, lead_id, removed }. removed=true means the lead was deleted; removed=false means it wasn't in the campaign (no-op).`,
      inputSchema: {
        campaign_id: z
          .string()
          .describe("Instantly campaign id (from instantly_list_campaigns)."),
        lead_id: z
          .string()
          .describe("Instantly lead id (from instantly_list_leads)."),
      },
      outputSchema: RemoveLeadShape,
      annotations: {
        title: "Remove lead from campaign",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await removeLeadFromCampaign(args)),
  )

  server.registerTool(
    "instantly_get_campaign_stats",
    {
      title: "Get campaign stats",
      description: `Send/open/reply/bounce/unsubscribe counts and rates for a campaign.

When to use: reporting — "how is Q2 Outbound performing?", "what's the bounce rate?".
Prerequisites: campaign_id from instantly_list_campaigns.
Returns: { campaign_id, sent, delivered, opened, replied, bounced, unsubscribed, open_rate, reply_rate, bounce_rate }. Rates are 0..1 (e.g. 0.42 = 42%) and computed against delivered (or sent if delivered is unavailable).
Errors: { code: 'not_found' } if campaign_id doesn't resolve.`,
      inputSchema: {
        campaign_id: z
          .string()
          .describe("Instantly campaign id (from instantly_list_campaigns)."),
      },
      outputSchema: StatsShape,
      annotations: {
        title: "Get campaign stats",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await getCampaignStats(args)),
  )

  server.registerTool(
    "instantly_send_test_email",
    {
      title: "Send test email",
      description: `Send a test of one campaign step to a single recipient — for QA/preview. The recipient does NOT enter the campaign.

When to use: the user wants to review a campaign step's rendered subject + body before activating. Use the user's own email address.
Side effects: 1 email is sent immediately to to_email. Test sends MAY count toward your daily mailbox quota — confirm with Instantly support if running large QA loops. They do NOT count toward campaign stats.
Prerequisites: campaign_id from instantly_list_campaigns; step_index from instantly_get_campaign.steps[].step_index (1-indexed).
Returns: { sent: true, to_email, step_index, campaign_id }.
Errors: { code: 'not_found' } if campaign or step doesn't exist. { code: 'validation_failed' } if to_email is malformed or step_index < 1.`,
      inputSchema: {
        campaign_id: z
          .string()
          .describe("Instantly campaign id (from instantly_list_campaigns)."),
        step_index: z
          .number()
          .int()
          .min(1)
          .describe(
            "Step number, 1-indexed. From instantly_get_campaign.steps[].step_index, e.g. 1 for the first email.",
          ),
        to_email: z
          .string()
          .describe(
            "Recipient address. Use the user's own email for QA, e.g. 'me@example.com'.",
          ),
      },
      outputSchema: SendTestEmailShape,
      annotations: {
        title: "Send test email",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => asText(await sendTestEmail(args)),
  )

  const SyncObjectShape = z.object({
    object_slug: z.string(),
    records_seen: z.number(),
    records_inserted: z.number(),
    records_updated: z.number(),
    errors_count: z.number(),
  })
  const SyncOutreachShape = {
    total_inserted: z.number(),
    total_updated: z.number(),
    rate_limited: z.boolean(),
    per_object: z.array(SyncObjectShape),
    ...ToolSuccessMetaShape,
  }
  const SetSyncEnabledShape = { enabled: z.boolean(), ...ToolSuccessMetaShape }

  server.registerTool(
    "instantly_sync_outreach",
    {
      title: "Sync Instantly outreach",
      description: `Pull Instantly campaigns + leads into local mirror tables (instantly_campaigns, instantly_leads). Runs automatically every 30 minutes. Use this tool to force an immediate refresh.

When to use: the user asks "sync my Instantly now", or after adding/pausing campaigns and you want the mirror to reflect the change before answering "what campaigns are running / who replied?".
Default mode: pulls everything (Instantly v2 has no incremental cursor — paginate via starting_after).
Returns: { total_inserted, total_updated, rate_limited, per_object: [...] }.`,
      inputSchema: {
        full: z.boolean().optional().describe("Reserved; sync always paginates the full list."),
      },
      outputSchema: SyncOutreachShape,
      annotations: {
        title: "Sync Instantly outreach",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => asText(await syncOutreachTool(args)),
  )

  server.registerTool(
    "instantly_set_sync_enabled",
    {
      title: "Enable or disable Instantly sync",
      description: `Turn the 30-minute auto-sync of Instantly campaigns + leads on or off. The mirror tables still serve stale reads when disabled.

When to use: the user explicitly asks to pause / resume Instantly syncing.
Returns: { enabled, result_summary }.`,
      inputSchema: {
        enabled: z.boolean().describe("true to enable auto-sync; false to disable."),
      },
      outputSchema: SetSyncEnabledShape,
      annotations: {
        title: "Set Instantly sync enabled",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => asText(await setSyncEnabledTool(args)),
  )
}
