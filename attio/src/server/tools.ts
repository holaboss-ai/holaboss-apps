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

  server.tool(
    "attio_describe_schema",
    "Describe Attio workspace schema — returns objects and their attributes (including custom ones). Call this before creating or updating records to learn the available fields. Defaults to [people, companies, deals]; pass objects to explore others.",
    {
      objects: z.array(z.string()).optional().describe("Object slugs to describe, e.g. ['people','companies','deals']"),
    },
    async ({ objects }) => {
      const r = await describeSchemaImpl({ objects })
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] }
    },
  )

  server.tool(
    "attio_get_connection_status",
    "Check whether Attio is connected for this workspace. Returns { connected, workspace_name }. If not connected, tell the user to connect Attio from the Holaboss integrations page.",
    {},
    async () => {
      const r = await getConnectionStatusImpl({})
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] }
    },
  )

  server.tool(
    "attio_find_people",
    "Search for people in Attio by name or email (fuzzy contains match). Returns up to limit records. Use this before creating a person to avoid duplicates.",
    {
      query: z.string().describe("Name fragment or email substring to search for"),
      limit: z.number().int().positive().max(100).optional().describe("Max results, default 20"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await findPeople(args)) }] }),
  )

  server.tool(
    "attio_get_person",
    "Fetch a single Attio person by record_id, returning all attribute values.",
    {
      record_id: z.string().describe("Attio person record id"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getPerson(args)) }] }),
  )

  server.tool(
    "attio_create_person",
    "Create a new person in Attio. Pass attributes as a map of {attribute_slug: value}. Call attio_describe_schema first to learn the available attributes (including custom ones). Attio validates fields on the server — 4xx errors come back as validation_failed with a message explaining what's wrong.",
    {
      attributes: z.record(z.string(), z.unknown()).describe("Map of attribute_slug → value, e.g. { name: 'Alice', email_addresses: ['a@b.com'] }"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createPerson(args)) }] }),
  )

  server.tool(
    "attio_update_person",
    "Patch an existing Attio person. Only the supplied attributes are modified; omitted fields remain unchanged.",
    {
      record_id: z.string().describe("Attio person record id"),
      attributes: z.record(z.string(), z.unknown()).describe("Map of attribute_slug → new value"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await updatePerson(args)) }] }),
  )

  server.tool(
    "attio_find_companies",
    "Search for companies in Attio by name or domain. Returns up to limit records.",
    {
      query: z.string().describe("Name fragment or domain substring"),
      limit: z.number().int().positive().max(100).optional().describe("Max results, default 20"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await findCompanies(args)) }] }),
  )

  server.tool(
    "attio_create_company",
    "Create a new company in Attio. Pass attributes as a map of {attribute_slug: value}. Call attio_describe_schema first to learn the workspace's fields.",
    {
      attributes: z.record(z.string(), z.unknown()).describe("Map of attribute_slug → value, e.g. { name: 'Acme', domains: ['acme.com'] }"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createCompany(args)) }] }),
  )

  server.tool(
    "attio_link_person_to_company",
    "Attach an existing person to an existing company by setting the person's 'company' reference attribute. Use this after creating or finding both records.",
    {
      person_id: z.string().describe("Attio person record id"),
      company_id: z.string().describe("Attio company record id"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await linkPersonToCompany(args)) }] }),
  )

  server.tool(
    "attio_add_note",
    "Attach a plaintext note to an Attio record (person, company, or deal). Use parent_object='people' for a person, 'companies' for a company, 'deals' for a deal. The note will appear in the record's timeline in Attio's UI.",
    {
      parent_object: z.enum(["people", "companies", "deals"]).describe("The type of record to attach the note to"),
      parent_record_id: z.string().describe("The record id to attach the note to"),
      title: z.string().describe("Note title"),
      content: z.string().describe("Note body (plaintext)"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await addNote(args)) }] }),
  )

  server.tool(
    "attio_create_task",
    "Create an Attio task (to-do). deadline_at must be an ISO 8601 string with an explicit timezone offset, e.g. '2026-04-20T10:00:00Z' or '2026-04-20T10:00:00-05:00'. linked_records attaches the task to one or more records.",
    {
      content: z.string().describe("Task description"),
      deadline_at: z.string().optional().describe("ISO 8601 deadline with timezone, e.g. '2026-04-20T10:00:00Z'"),
      assignee: z.string().optional().describe("Workspace member id to assign"),
      linked_records: z
        .array(z.object({ object: z.string(), record_id: z.string() }))
        .optional()
        .describe("Records to link this task to, e.g. [{ object: 'people', record_id: 'rec_1' }]"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createTask(args)) }] }),
  )

  server.tool(
    "attio_list_tasks",
    "List Attio tasks, optionally filtered by assignee, status (open/completed), or a linked record.",
    {
      filter: z
        .object({
          assignee: z.string().optional(),
          status: z.enum(["open", "completed"]).optional(),
          linked_record: z.object({ object: z.string(), record_id: z.string() }).optional(),
        })
        .optional(),
      limit: z.number().int().positive().max(200).optional().describe("Max results, default 50"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await listTasks(args)) }] }),
  )

  server.tool(
    "attio_list_records_in_list",
    "List all entries in an Attio List (pipeline). Each entry has its own entry_values (e.g. stage, deal value) separate from the parent record's attributes. Use this to inspect a pipeline's current state.",
    {
      list_id: z.string().describe("Attio list id"),
      limit: z.number().int().positive().max(200).optional().describe("Max entries, default 50"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await listRecordsInList(args)) }] }),
  )

  server.tool(
    "attio_add_to_list",
    "Add a record to an Attio List, OR update its stage/entry_values if it is already in the list. This tool merges the 'add' and 'move stage' operations: if the record is not yet in the list, a new entry is created with the given entry_values; if it already exists, the existing entry's values are updated. entry_values are list-level attributes (stage, deal value, etc.), distinct from the parent record's attributes.",
    {
      list_id: z.string().describe("Attio list id"),
      record_id: z.string().describe("Attio record id of the person/company/deal to add"),
      parent_object: z.enum(["people", "companies", "deals"]).describe("Type of the record being added"),
      entry_values: z.record(z.string(), z.unknown()).optional().describe("List-level entry attributes (e.g. stage, deal value)"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await addToList(args)) }] }),
  )
}