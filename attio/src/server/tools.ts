import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { apiGet, apiPost, apiPatch } from "./attio-client"
import { wrapTool } from "./audit"
import { buildFuzzyPeopleQuery, buildFuzzyCompaniesQuery } from "./query-builder"
import type { AttioError, AttioRecord, Result, ToolSuccessMeta } from "../lib/types"

const ATTIO_APP_BASE = "https://app.attio.com"

function personDeepLink(id: string) {
  return `${ATTIO_APP_BASE}/records/people/${id}`
}
function companyDeepLink(id: string) {
  return `${ATTIO_APP_BASE}/records/companies/${id}`
}
function dealDeepLink(id: string) {
  return `${ATTIO_APP_BASE}/records/deals/${id}`
}
function deepLinkFor(parent: "people" | "companies" | "deals", id: string) {
  if (parent === "people") return personDeepLink(id)
  if (parent === "companies") return companyDeepLink(id)
  return dealDeepLink(id)
}

function normalizeRecord(raw: Record<string, unknown>): AttioRecord {
  const id = raw.id && typeof raw.id === "object" && "record_id" in (raw.id as Record<string, unknown>)
    ? String((raw.id as Record<string, unknown>).record_id)
    : String(raw.id ?? "")
  return { id, values: (raw.values as Record<string, unknown>) ?? {} }
}

export interface DescribeSchemaInput {
  objects?: string[]
}
export interface SchemaAttribute {
  slug: string
  title: string
  type: string
  is_required: boolean
  is_unique: boolean
  options?: unknown
}
export interface SchemaObject {
  slug: string
  plural_name: string
  attributes: SchemaAttribute[]
}

export async function describeSchemaImpl(
  input: DescribeSchemaInput,
): Promise<Result<{ objects: SchemaObject[] } & ToolSuccessMeta, AttioError>> {
  const slugs = input.objects ?? ["people", "companies", "deals"]
  const objects: SchemaObject[] = []
  for (const slug of slugs) {
    const r = await apiGet<{ data: Array<Record<string, unknown>> }>(`/objects/${slug}/attributes`)
    if (!r.ok) return r
    const attrs: SchemaAttribute[] = (r.data.data ?? []).map((a) => ({
      slug: String(a.api_slug ?? a.slug ?? ""),
      title: String(a.title ?? ""),
      type: String(a.type ?? ""),
      is_required: Boolean(a.is_required),
      is_unique: Boolean(a.is_unique),
      options: a.config ?? a.options ?? undefined,
    }))
    objects.push({ slug, plural_name: slug, attributes: attrs })
  }
  return { ok: true, data: { objects, result_summary: `Described ${objects.length} Attio object(s)` } }
}

export async function getConnectionStatusImpl(
  _input: Record<string, never>,
): Promise<Result<{ connected: boolean; workspace_name?: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiGet<{ data: { workspace_name?: string } }>("/self")
  if (r.ok) {
    return {
      ok: true,
      data: {
        connected: true,
        workspace_name: r.data.data?.workspace_name,
        result_summary: "Connection verified",
      },
    }
  }
  if (r.error.code === "not_connected") {
    return { ok: true, data: { connected: false, result_summary: "Not connected" } }
  }
  return r as unknown as Result<{ connected: boolean } & ToolSuccessMeta, AttioError>
}

export interface FindPeopleInput { query: string; limit?: number }
export async function findPeopleImpl(
  input: FindPeopleInput,
): Promise<Result<{ records: AttioRecord[] } & ToolSuccessMeta, AttioError>> {
  const body = buildFuzzyPeopleQuery(input.query, input.limit ?? 20)
  const r = await apiPost<{ data: Array<Record<string, unknown>> }>("/objects/people/records/query", body)
  if (!r.ok) return r
  const records = (r.data.data ?? []).map(normalizeRecord)
  return {
    ok: true,
    data: {
      records,
      attio_object: "people",
      result_summary: `Found ${records.length} people matching "${input.query}"`,
    },
  }
}

export interface GetPersonInput { record_id: string }
export async function getPersonImpl(
  input: GetPersonInput,
): Promise<Result<{ record: AttioRecord } & ToolSuccessMeta, AttioError>> {
  const r = await apiGet<{ data: Record<string, unknown> }>(`/objects/people/records/${input.record_id}`)
  if (!r.ok) return r
  const record = normalizeRecord(r.data.data ?? {})
  return {
    ok: true,
    data: {
      record,
      attio_object: "people",
      attio_record_id: record.id,
      attio_deep_link: personDeepLink(record.id),
      result_summary: `Fetched person ${record.id}`,
    },
  }
}

export interface CreatePersonInput { attributes: Record<string, unknown> }
export async function createPersonImpl(
  input: CreatePersonInput,
): Promise<Result<{ record_id: string; record_url: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>("/objects/people/records", {
    data: { values: input.attributes },
  })
  if (!r.ok) return r
  const record = normalizeRecord(r.data.data ?? {})
  return {
    ok: true,
    data: {
      record_id: record.id,
      record_url: personDeepLink(record.id),
      attio_object: "people",
      attio_record_id: record.id,
      attio_deep_link: personDeepLink(record.id),
      result_summary: `Created person ${record.id}`,
    },
  }
}

export interface UpdatePersonInput { record_id: string; attributes: Record<string, unknown> }
export async function updatePersonImpl(
  input: UpdatePersonInput,
): Promise<Result<{ record_id: string; record_url: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiPatch<{ data: Record<string, unknown> }>(
    `/objects/people/records/${input.record_id}`,
    { data: { values: input.attributes } },
  )
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      record_id: input.record_id,
      record_url: personDeepLink(input.record_id),
      attio_object: "people",
      attio_record_id: input.record_id,
      attio_deep_link: personDeepLink(input.record_id),
      result_summary: `Updated person ${input.record_id}`,
    },
  }
}

export interface FindCompaniesInput { query: string; limit?: number }
export async function findCompaniesImpl(
  input: FindCompaniesInput,
): Promise<Result<{ records: AttioRecord[] } & ToolSuccessMeta, AttioError>> {
  const body = buildFuzzyCompaniesQuery(input.query, input.limit ?? 20)
  const r = await apiPost<{ data: Array<Record<string, unknown>> }>("/objects/companies/records/query", body)
  if (!r.ok) return r
  const records = (r.data.data ?? []).map(normalizeRecord)
  return {
    ok: true,
    data: {
      records,
      attio_object: "companies",
      result_summary: `Found ${records.length} companies matching "${input.query}"`,
    },
  }
}

export interface CreateCompanyInput { attributes: Record<string, unknown> }
export async function createCompanyImpl(
  input: CreateCompanyInput,
): Promise<Result<{ record_id: string; record_url: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>("/objects/companies/records", {
    data: { values: input.attributes },
  })
  if (!r.ok) return r
  const record = normalizeRecord(r.data.data ?? {})
  return {
    ok: true,
    data: {
      record_id: record.id,
      record_url: companyDeepLink(record.id),
      attio_object: "companies",
      attio_record_id: record.id,
      attio_deep_link: companyDeepLink(record.id),
      result_summary: `Created company ${record.id}`,
    },
  }
}

export interface LinkPersonToCompanyInput { person_id: string; company_id: string }
export async function linkPersonToCompanyImpl(
  input: LinkPersonToCompanyInput,
): Promise<Result<{ ok: true } & ToolSuccessMeta, AttioError>> {
  const r = await apiPatch<{ data: Record<string, unknown> }>(
    `/objects/people/records/${input.person_id}`,
    {
      data: {
        values: {
          company: [{ target_object: "companies", target_record_id: input.company_id }],
        },
      },
    },
  )
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      ok: true as const,
      attio_object: "people",
      attio_record_id: input.person_id,
      attio_deep_link: personDeepLink(input.person_id),
      result_summary: `Linked person ${input.person_id} to company ${input.company_id}`,
    },
  }
}

export interface AddNoteInput {
  parent_object: "people" | "companies" | "deals"
  parent_record_id: string
  title: string
  content: string
}
export async function addNoteImpl(
  input: AddNoteInput,
): Promise<Result<{ note_id: string; note_url: string } & ToolSuccessMeta, AttioError>> {
  const r = await apiPost<{ data: Record<string, unknown> }>("/notes", {
    data: {
      parent_object: input.parent_object,
      parent_record_id: input.parent_record_id,
      title: input.title,
      content: input.content,
      format: "plaintext",
    },
  })
  if (!r.ok) return r
  const raw = r.data.data ?? {}
  const id = raw.id && typeof raw.id === "object" && "note_id" in (raw.id as Record<string, unknown>)
    ? String((raw.id as Record<string, unknown>).note_id)
    : String(raw.id ?? "")
  const parentLink = deepLinkFor(input.parent_object, input.parent_record_id)
  return {
    ok: true,
    data: {
      note_id: id,
      note_url: parentLink,
      attio_object: input.parent_object,
      attio_record_id: input.parent_record_id,
      attio_deep_link: parentLink,
      result_summary: `Added note "${input.title}" to ${input.parent_object}/${input.parent_record_id}`,
    },
  }
}

export interface CreateTaskInput {
  content: string
  deadline_at?: string
  assignee?: string
  linked_records?: Array<{ object: string; record_id: string }>
}
export async function createTaskImpl(
  input: CreateTaskInput,
): Promise<Result<{ task_id: string } & ToolSuccessMeta, AttioError>> {
  const body = {
    data: {
      content: input.content,
      format: "plaintext",
      deadline_at: input.deadline_at ?? null,
      assignees: input.assignee ? [{ referenced_actor_type: "workspace-member", referenced_actor_id: input.assignee }] : [],
      linked_records: (input.linked_records ?? []).map((l) => ({
        target_object: l.object,
        target_record_id: l.record_id,
      })),
    },
  }
  const r = await apiPost<{ data: Record<string, unknown> }>("/tasks", body)
  if (!r.ok) return r
  const raw = r.data.data ?? {}
  const id = raw.id && typeof raw.id === "object" && "task_id" in (raw.id as Record<string, unknown>)
    ? String((raw.id as Record<string, unknown>).task_id)
    : String(raw.id ?? "")
  return {
    ok: true,
    data: {
      task_id: id,
      result_summary: `Created task "${input.content.slice(0, 40)}"`,
    },
  }
}

export interface ListTasksInput {
  filter?: {
    assignee?: string
    status?: "open" | "completed"
    linked_record?: { object: string; record_id: string }
  }
  limit?: number
}
export interface TaskSummary {
  id: string
  content: string
  deadline_at: string | null
  is_completed: boolean
  linked_records: Array<{ object: string; record_id: string }>
}
export async function listTasksImpl(
  input: ListTasksInput,
): Promise<Result<{ tasks: TaskSummary[] } & ToolSuccessMeta, AttioError>> {
  const params = new URLSearchParams()
  params.set("limit", String(input.limit ?? 50))
  if (input.filter?.status === "completed") params.set("is_completed", "true")
  if (input.filter?.status === "open") params.set("is_completed", "false")
  if (input.filter?.assignee) params.set("assignee", input.filter.assignee)
  if (input.filter?.linked_record) {
    params.set("linked_object", input.filter.linked_record.object)
    params.set("linked_record_id", input.filter.linked_record.record_id)
  }
  const r = await apiGet<{ data: Array<Record<string, unknown>> }>(`/tasks?${params.toString()}`)
  if (!r.ok) return r
  const tasks: TaskSummary[] = (r.data.data ?? []).map((t) => ({
    id: t.id && typeof t.id === "object" && "task_id" in (t.id as Record<string, unknown>)
      ? String((t.id as Record<string, unknown>).task_id)
      : String(t.id ?? ""),
    content: String(t.content ?? ""),
    deadline_at: (t.deadline_at as string | null) ?? null,
    is_completed: Boolean(t.is_completed),
    linked_records: Array.isArray(t.linked_records)
      ? (t.linked_records as Array<Record<string, unknown>>).map((l) => ({
          object: String(l.target_object ?? l.object ?? ""),
          record_id: String(l.target_record_id ?? l.record_id ?? ""),
        }))
      : [],
  }))
  return { ok: true, data: { tasks, result_summary: `Listed ${tasks.length} task(s)` } }
}

export interface ListEntrySummary {
  entry_id: string
  record_id: string
  parent_object: string
  entry_values: Record<string, unknown>
}

export interface ListRecordsInListInput { list_id: string; limit?: number }
export async function listRecordsInListImpl(
  input: ListRecordsInListInput,
): Promise<Result<{ entries: ListEntrySummary[] } & ToolSuccessMeta, AttioError>> {
  const r = await apiPost<{ data: Array<Record<string, unknown>> }>(
    `/lists/${input.list_id}/entries/query`,
    { limit: input.limit ?? 50 },
  )
  if (!r.ok) return r
  const entries: ListEntrySummary[] = (r.data.data ?? []).map((e) => ({
    entry_id: e.id && typeof e.id === "object" && "entry_id" in (e.id as Record<string, unknown>)
      ? String((e.id as Record<string, unknown>).entry_id)
      : String(e.id ?? ""),
    record_id: String(e.parent_record_id ?? ""),
    parent_object: String(e.parent_object ?? ""),
    entry_values: (e.entry_values as Record<string, unknown>) ?? {},
  }))
  return {
    ok: true,
    data: { entries, result_summary: `Listed ${entries.length} entries in list ${input.list_id}` },
  }
}

export interface AddToListInput {
  list_id: string
  record_id: string
  parent_object: "people" | "companies" | "deals"
  entry_values?: Record<string, unknown>
}
export async function addToListImpl(
  input: AddToListInput,
): Promise<Result<{ entry_id: string } & ToolSuccessMeta, AttioError>> {
  const existing = await apiPost<{ data: Array<Record<string, unknown>> }>(
    `/lists/${input.list_id}/entries/query`,
    {
      limit: 1,
      filter: {
        parent_object: input.parent_object,
        parent_record_id: input.record_id,
      },
    },
  )
  if (!existing.ok) return existing
  const found = (existing.data.data ?? [])[0]

  if (found) {
    const entryId = found.id && typeof found.id === "object" && "entry_id" in (found.id as Record<string, unknown>)
      ? String((found.id as Record<string, unknown>).entry_id)
      : String(found.id ?? "")
    const r = await apiPatch<{ data: Record<string, unknown> }>(
      `/lists/${input.list_id}/entries/${entryId}`,
      { data: { entry_values: input.entry_values ?? {} } },
    )
    if (!r.ok) return r
    return {
      ok: true,
      data: {
        entry_id: entryId,
        attio_object: input.parent_object,
        attio_record_id: input.record_id,
        attio_deep_link: deepLinkFor(input.parent_object, input.record_id),
        result_summary: `Updated list entry ${entryId} in list ${input.list_id}`,
      },
    }
  }

  const r = await apiPost<{ data: Record<string, unknown> }>(`/lists/${input.list_id}/entries`, {
    data: {
      parent_object: input.parent_object,
      parent_record_id: input.record_id,
      entry_values: input.entry_values ?? {},
    },
  })
  if (!r.ok) return r
  const raw = r.data.data ?? {}
  const entryId = raw.id && typeof raw.id === "object" && "entry_id" in (raw.id as Record<string, unknown>)
    ? String((raw.id as Record<string, unknown>).entry_id)
    : String(raw.id ?? "")
  return {
    ok: true,
    data: {
      entry_id: entryId,
      attio_object: input.parent_object,
      attio_record_id: input.record_id,
      attio_deep_link: deepLinkFor(input.parent_object, input.record_id),
      result_summary: `Added ${input.parent_object}/${input.record_id} to list ${input.list_id}`,
    },
  }
}

// Tool descriptions follow ../../../docs/MCP_TOOL_DESCRIPTION_CONVENTION.md
export function registerTools(server: McpServer): void {
  const findPeople = wrapTool("attio_find_people", findPeopleImpl)
  const getPerson = wrapTool("attio_get_person", getPersonImpl)
  const createPerson = wrapTool("attio_create_person", createPersonImpl)
  const updatePerson = wrapTool("attio_update_person", updatePersonImpl)
  const findCompanies = wrapTool("attio_find_companies", findCompaniesImpl)
  const createCompany = wrapTool("attio_create_company", createCompanyImpl)
  const linkPersonToCompany = wrapTool("attio_link_person_to_company", linkPersonToCompanyImpl)
  const addNote = wrapTool("attio_add_note", addNoteImpl)
  const createTask = wrapTool("attio_create_task", createTaskImpl)
  const listTasks = wrapTool("attio_list_tasks", listTasksImpl)
  const listRecordsInList = wrapTool("attio_list_records_in_list", listRecordsInListImpl)
  const addToList = wrapTool("attio_add_to_list", addToListImpl)

  server.registerTool(
    "attio_describe_schema",
    {
      title: "Describe Attio schema",
      description: `Describe the Attio workspace's objects and their attributes (including custom fields).

When to use: ALWAYS call this before attio_create_person / attio_create_company / attio_update_person to learn the workspace's actual attribute slugs — schema differs per workspace.
Returns: { objects: [{ api_slug, name, attributes: [{ api_slug, type, is_required, is_multiselect, options? }] }] }. Default scope is [people, companies, deals]; pass objects to explore others.`,
      inputSchema: {
        objects: z
          .array(z.string())
          .optional()
          .describe("Object api_slugs to describe, e.g. ['people','companies','deals','workspaces']."),
      },
      annotations: {
        title: "Describe Attio schema",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ objects }) => {
      const r = await describeSchemaImpl({ objects })
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] }
    },
  )

  server.registerTool(
    "attio_get_connection_status",
    {
      title: "Check Attio connection",
      description: `Check whether Attio is connected for this workspace.

When to use: ALWAYS call this first if any Attio tool returns a not_connected error, or before suggesting Attio features for the first time.
Returns: { connected: true, workspace_name } if linked, { connected: false } otherwise. If false, tell the user to connect Attio from the Holaboss integrations page.`,
      inputSchema: {},
      annotations: {
        title: "Check Attio connection",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const r = await getConnectionStatusImpl({})
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] }
    },
  )

  server.registerTool(
    "attio_find_people",
    {
      title: "Find people",
      description: `Search Attio people by name or email (fuzzy contains match).

When to use: ALWAYS call this before attio_create_person to avoid duplicates.
Returns: array of person records, each with record_id and attribute values.`,
      inputSchema: {
        query: z
          .string()
          .describe("Name fragment or email substring, e.g. 'alice' or 'acme.com'. Case-insensitive contains match."),
        limit: z.number().int().positive().max(100).optional().describe("Max results, default 20, max 100."),
      },
      annotations: {
        title: "Find people",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await findPeople(args)) }] }),
  )

  server.registerTool(
    "attio_get_person",
    {
      title: "Get person",
      description: `Fetch a single Attio person by record_id with all attribute values.

Prerequisites: record_id from attio_find_people.
Returns: full person record with attribute slugs as keys.`,
      inputSchema: {
        record_id: z.string().describe("Attio person record id (from attio_find_people)."),
      },
      annotations: {
        title: "Get person",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getPerson(args)) }] }),
  )

  server.registerTool(
    "attio_create_person",
    {
      title: "Create person",
      description: `Create a new person in Attio.

When to use: after attio_find_people confirms the person doesn't already exist.
Prerequisites: call attio_describe_schema first to learn this workspace's attribute slugs (especially custom fields).
Returns: { record_id, ... } of the created person.
Errors: { code: 'validation_failed', message } if Attio rejects the payload — usually a missing required field or wrong attribute type.`,
      inputSchema: {
        attributes: z
          .record(z.string(), z.unknown())
          .describe(
            "Map of attribute_slug → value, e.g. { name: 'Alice', email_addresses: ['a@b.com'], job_title: 'CTO' }. Slugs come from attio_describe_schema.",
          ),
      },
      annotations: {
        title: "Create person",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createPerson(args)) }] }),
  )

  server.registerTool(
    "attio_update_person",
    {
      title: "Update person",
      description: `Patch an existing Attio person. Only the supplied attributes change; omitted fields remain unchanged.

Prerequisites: record_id from attio_find_people; attribute slugs from attio_describe_schema.
Returns: updated person record.
Errors: { code: 'validation_failed', message } if Attio rejects the payload.`,
      inputSchema: {
        record_id: z.string().describe("Attio person record id (from attio_find_people)."),
        attributes: z
          .record(z.string(), z.unknown())
          .describe(
            "Map of attribute_slug → new value, e.g. { job_title: 'VP Engineering' }. Only listed slugs are modified.",
          ),
      },
      annotations: {
        title: "Update person",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await updatePerson(args)) }] }),
  )

  server.registerTool(
    "attio_find_companies",
    {
      title: "Find companies",
      description: `Search Attio companies by name or domain (fuzzy contains match).

When to use: ALWAYS call this before attio_create_company to avoid duplicates.
Returns: array of company records, each with record_id and attribute values.`,
      inputSchema: {
        query: z
          .string()
          .describe("Name fragment or domain substring, e.g. 'acme' or 'acme.com'. Case-insensitive contains match."),
        limit: z.number().int().positive().max(100).optional().describe("Max results, default 20, max 100."),
      },
      annotations: {
        title: "Find companies",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await findCompanies(args)) }] }),
  )

  server.registerTool(
    "attio_create_company",
    {
      title: "Create company",
      description: `Create a new company in Attio.

When to use: after attio_find_companies confirms the company doesn't already exist.
Prerequisites: call attio_describe_schema first to learn this workspace's attribute slugs.
Returns: { record_id, ... } of the created company.
Errors: { code: 'validation_failed', message } if Attio rejects the payload.`,
      inputSchema: {
        attributes: z
          .record(z.string(), z.unknown())
          .describe(
            "Map of attribute_slug → value, e.g. { name: 'Acme', domains: ['acme.com'], industry: 'Software' }. Slugs come from attio_describe_schema.",
          ),
      },
      annotations: {
        title: "Create company",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createCompany(args)) }] }),
  )

  server.registerTool(
    "attio_link_person_to_company",
    {
      title: "Link person to company",
      description: `Attach an existing person to an existing company by setting the person's 'company' reference attribute.

When to use: after creating or finding BOTH records, to wire them together.
Prerequisites: person_id from attio_find_people / attio_create_person; company_id from attio_find_companies / attio_create_company.
Returns: updated person record showing the new company link.`,
      inputSchema: {
        person_id: z.string().describe("Attio person record id."),
        company_id: z.string().describe("Attio company record id."),
      },
      annotations: {
        title: "Link person to company",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await linkPersonToCompany(args)) }] }),
  )

  server.registerTool(
    "attio_add_note",
    {
      title: "Add note",
      description: `Attach a plaintext note to an Attio record. The note appears in the record's timeline in the Attio UI.

When to use: log meeting summaries, follow-up details, or any free-form context against a person/company/deal.
Prerequisites: parent_record_id from attio_find_people / attio_find_companies (or the relevant deals tool).
Returns: { note_id, ... } of the created note.`,
      inputSchema: {
        parent_object: z
          .enum(["people", "companies", "deals"])
          .describe("Record type the note is attached to."),
        parent_record_id: z.string().describe("Attio record id (person/company/deal) to attach the note to."),
        title: z.string().describe("Note title (single line)."),
        content: z.string().describe("Note body in plaintext (no Markdown rendering in Attio's timeline)."),
      },
      annotations: {
        title: "Add note",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await addNote(args)) }] }),
  )

  server.registerTool(
    "attio_create_task",
    {
      title: "Create task",
      description: `Create an Attio task (to-do), optionally with a deadline, assignee, and links to related records.

When to use: capture an action item — "follow up with Alice next Monday" — that needs to surface in someone's task list.
Returns: { task_id, ... } of the created task.`,
      inputSchema: {
        content: z.string().describe("Task description, e.g. 'Send Q2 proposal'."),
        deadline_at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 deadline with explicit timezone offset, e.g. '2026-04-20T10:00:00Z' or '2026-04-20T10:00:00-05:00'.",
          ),
        assignee: z
          .string()
          .optional()
          .describe("Attio workspace member id to assign. Omit to leave unassigned."),
        linked_records: z
          .array(z.object({ object: z.string(), record_id: z.string() }))
          .optional()
          .describe(
            "Records to link this task to, e.g. [{ object: 'people', record_id: 'rec_1' }, { object: 'companies', record_id: 'rec_2' }].",
          ),
      },
      annotations: {
        title: "Create task",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createTask(args)) }] }),
  )

  server.registerTool(
    "attio_list_tasks",
    {
      title: "List tasks",
      description: `List Attio tasks, optionally filtered by assignee, status, or a linked record.

When to use: "what's open for me?" → filter.assignee. "What's outstanding for Acme?" → filter.linked_record.
Returns: array of tasks with content, deadline_at, status, assignee, linked_records.`,
      inputSchema: {
        filter: z
          .object({
            assignee: z.string().optional().describe("Workspace member id to scope to."),
            status: z.enum(["open", "completed"]).optional().describe("Task lifecycle state."),
            linked_record: z
              .object({ object: z.string(), record_id: z.string() })
              .optional()
              .describe("Record the task is linked to, e.g. { object: 'people', record_id: 'rec_1' }."),
          })
          .optional()
          .describe("Optional combined filter. Omit to list all."),
        limit: z.number().int().positive().max(200).optional().describe("Max results, default 50, max 200."),
      },
      annotations: {
        title: "List tasks",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await listTasks(args)) }] }),
  )

  server.registerTool(
    "attio_list_records_in_list",
    {
      title: "List records in pipeline",
      description: `List all entries in an Attio List (a.k.a. pipeline). Each entry has its OWN entry_values (e.g. stage, deal value) separate from the parent record's attributes.

When to use: inspect a pipeline's current state — e.g. who's in 'Q2 Sales' and what stage they're at.
Returns: array of { entry_id, parent_record_id, parent_object, entry_values: { stage, deal_value, ... } }.`,
      inputSchema: {
        list_id: z.string().describe("Attio list id (find via the Attio UI's list URL)."),
        limit: z.number().int().positive().max(200).optional().describe("Max entries, default 50, max 200."),
      },
      annotations: {
        title: "List records in pipeline",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await listRecordsInList(args)) }] }),
  )

  server.registerTool(
    "attio_add_to_list",
    {
      title: "Add or update list entry",
      description: `Upsert a record into an Attio List: if the record is not yet in the list, a new entry is created with the given entry_values; if it already exists, the existing entry's values are updated.

When to use: this is the SAME tool for "add to pipeline" AND "move to next stage" — pass the new stage in entry_values either way.
Prerequisites: record_id from attio_find_people / attio_find_companies (or deals tool); parent_object must match the record's type.
Returns: { entry_id, parent_record_id, ... }.`,
      inputSchema: {
        list_id: z.string().describe("Attio list id (find via the Attio UI's list URL)."),
        record_id: z
          .string()
          .describe("Attio record id of the person/company/deal to add (from attio_find_people / attio_find_companies)."),
        parent_object: z
          .enum(["people", "companies", "deals"])
          .describe("Type of the record being added — must match what record_id refers to."),
        entry_values: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "List-level entry attributes (e.g. { stage: 'qualified', deal_value: 5000 }). DISTINCT from the parent record's attributes.",
          ),
      },
      annotations: {
        title: "Add or update list entry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await addToList(args)) }] }),
  )
}