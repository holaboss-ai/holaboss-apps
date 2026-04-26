# MCP Tool Description Convention

**Audience:** authors of any module under `hola-boss-apps/`.
**Goal:** every MCP tool we expose tells the agent (a) what it does, (b) when to call it, (c) what it needs first, and (d) what it returns — without the agent having to experiment.

The agent only sees the tool name, the description, the input schema, and the annotations. **Anything not in those four places is invisible.** CLAUDE.md, README files, and code comments don't reach the agent at runtime.

---

## TL;DR — the contract

Use `server.registerTool(name, config, handler)`. The legacy `server.tool(...)` overload is deprecated in `@modelcontextprotocol/sdk ≥ 1.27`.

```ts
server.registerTool(
  "twitter_create_post",
  {
    title: "Create tweet draft",
    description: "<multi-line, structured — see template below>",
    inputSchema: {
      content: z.string().max(280).describe("Tweet body, max 280 chars."),
      scheduled_at: z.string().optional().describe(
        "ISO 8601 with timezone, e.g. '2026-04-26T15:00:00Z'. Stored on the draft only; call twitter_publish_post to actually schedule.",
      ),
    },
    annotations: {
      title: "Create tweet draft",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ content, scheduled_at }, extra) => { /* ... */ },
)
```

---

## 1. Naming

- Module-prefixed snake_case: `twitter_create_post`, `attio_find_people`, `gmail_send_draft`.
- Verb in the middle (`_create_`, `_list_`, `_get_`, `_update_`, `_delete_`, `_publish_`, `_send_`, `_cancel_`).
- Keep ≤ 30 chars. Two prefixes max (`gmail_get_send_status` is fine; `gmail_get_send_status_for_thread` is not).

## 2. `title`

A short human-readable label (≤ 6 words), used by IDEs and debug UIs. Example: `"Create tweet draft"`, `"Cancel Cal.com booking"`. Mirror it inside `annotations.title` too.

## 3. `description` — the structured template

```
{One sentence in active voice. State the visible effect, not the implementation.}

When to use: {what user intent or trigger phrase this serves}.
When NOT to use: {sibling tools that look similar; what to call instead}.
{Optional} Prerequisites: {ids that must come from another tool; state that must already exist}.
{Optional} Valid states: {state-machine constraint, if applicable}.
Returns: {summary of the fields the agent will see in the result}.
{Optional} Errors: {recognizable error shapes; isError=true with message X means Y}.
```

Rules:

- **Keep it ≤ 12 lines.** Below 4 lines means too thin; above 12 means split the tool.
- **No marketing or filler** ("powerful", "easy"). The agent doesn't need persuasion.
- **No restating the tool name.** "twitter_create_post creates a Twitter post" is wasted tokens.
- **No implementation details.** No SQL, no internal function names, no file paths.
- **No information that depends on the workspace** (e.g. "this only works for premium users") — those go in runtime errors.
- **Cross-reference sibling tools by name** when there's a flow: `"call <other_tool> next"`, `"sibling: <other_tool>"`.

## 4. `inputSchema` — every field MUST `.describe(...)`

Each `.describe()` should include up to four things:

1. **Format / unit / shape** — `"ISO 8601 with timezone"`, `"A1 notation"`, `"snake_case slug"`, `"subreddit name without 'r/' prefix"`.
2. **Example value in single quotes** — `'2026-04-26T15:00:00Z'`, `'Sheet1!A1:C10'`, `'learnprogramming'`.
3. **Cross-reference** — when the value typically comes from another tool: `"post_id returned by twitter_create_post"`.
4. **Default / limit** — `"max 280 chars"`, `"default 20, max 100"`.

If a string has a known max length, also enforce with Zod (`z.string().max(280)`) so it fails server-side instead of just hinting.

For `z.record(...)` or `z.array(z.object(...))`, give a literal example: `"e.g. { name: 'Alice', email_addresses: ['a@b.com'] }"`.

## 5. `annotations` — set every flag explicitly

The agent uses these to decide retry / preview / consent behavior. Don't rely on defaults — false-by-omission and false-by-decision look the same to the agent, but the latter is auditable.

| Operation kind                                  | readOnly | destructive | idempotent | openWorld   |
|-------------------------------------------------|----------|-------------|------------|-------------|
| `_list_*` / `_get_*` / `_search`                | true     | false       | true       | depends*    |
| `_create_*`                                     | false    | false       | false      | depends*    |
| `_update_*` / `_open_*` (upsert)                | false    | false       | true       | depends*    |
| `_delete_*` / `_cancel_*`                       | false    | true        | true       | depends*    |
| `_publish_*` / `_send_*` (effect leaves system) | false    | false       | false      | true        |

**`openWorldHint` rule of thumb:**
- `false` — tool only touches the module's local SQLite (e.g. creating a draft, listing local drafts, queue stats).
- `true` — tool reads or writes a remote third-party service (Gmail, Sheets, GitHub, Cal.com, Attio, X, LinkedIn, Reddit), OR the user-visible effect lands outside our system (publish, send, cancel a published booking).

`destructiveHint` is **only** for tools that lose data without a recovery path: hard delete, cancel-with-no-undo, irreversible state transition. A status flip back to `'draft'` is not destructive; deleting the row is.

## 6. Result format

Return `{ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }`. Don't add `outputSchema` yet — that's a separate migration. The "Returns:" line in the description is what the agent uses to predict the shape.

For errors: `{ content: [{ type: "text", text: <message> }], isError: true }`. The message should match a recognizable shape mentioned in the description's "Errors:" line.

## 7. What does NOT go in the description

- Implementation details (SQL, function names, file paths).
- Marketing language.
- Information already conveyed by the tool name.
- Workspace-specific or user-specific facts.
- Apologies or hedges ("might fail", "tries to"). State the contract; let runtime errors handle exceptions.

Everything else lives in code comments or this doc — NOT in the description, where it costs the agent context tokens on every list-tools call.

---

## Reference implementations

Look at these in source order:

1. `_template/src/server/mcp.ts` — the canonical minimal example. Copy this when starting a new module.
2. `attio/src/server/tools.ts` — best example for tools with prerequisites (`attio_describe_schema` first), external-API error shapes, and an upsert (`attio_add_to_list`).
3. `gmail/src/server/mcp.ts` — best example for state-machine flows and cross-tool narration (draft → send_draft → get_send_status).
4. `calcom/src/server/tools.ts` — best example for read-heavy tools that gate write tools behind `get_connection_status`.

If you're unsure how to phrase something, copy from one of these four.

---

## Migration checklist (when porting an existing module)

- [ ] Replace every `server.tool(name, desc, schema, handler)` with `server.registerTool(name, { title, description, inputSchema, annotations }, handler)`.
- [ ] Description rewritten with the structured template (one sentence + sections).
- [ ] Every input field has a `.describe()` with format + example + cross-ref where relevant.
- [ ] String fields with known limits use `z.string().max(N)`.
- [ ] All four annotation flags are set explicitly.
- [ ] `npm run typecheck` passes.
- [ ] No references to internal SQL / function names in any description.
