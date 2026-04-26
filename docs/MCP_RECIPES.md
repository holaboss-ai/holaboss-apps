# MCP Recipes — multi-tool workflows the agent should know

Tool descriptions can only describe one tool. **Workflows** — sequences of tool calls a user typically wants — live here.

Each recipe is written from the agent's POV: when the user says X, run these tools in this order. Treat this file as agent-facing guidance, not just engineer docs — when the convention changes, update this too.

For the description spec each tool follows, see [`MCP_TOOL_DESCRIPTION_CONVENTION.md`](MCP_TOOL_DESCRIPTION_CONVENTION.md).

---

## Recipe shape

```
### <Recipe title>

User intent: <what the user typed / asked for, paraphrased>
Modules touched: <module1>, <module2>, ...

Steps:
1. tool_name(args) — purpose
2. tool_name(args) — purpose
...

Watch out: <the one or two non-obvious things that go wrong>
```

If a recipe needs more than ~6 steps, split it.

---

## Twitter / LinkedIn / Reddit (publishing modules)

### Schedule a post for a specific time

User intent: "Tweet this next Monday at 9am UTC: <body>"
Modules touched: twitter (or linkedin / reddit — same shape).

Steps:
1. `twitter_create_post({ content, scheduled_at: "2026-04-27T09:00:00Z" })` — drafts the tweet locally with the schedule recorded on the draft. Status is `'draft'`.
2. `twitter_publish_post({ post_id })` — moves the draft into the queue. Because `scheduled_at` is in the future, the worker holds the job until then. Status flips to `'queued'`.
3. (optional) `twitter_get_publish_status({ post_id })` — confirm `status: 'scheduled'`.

Watch out:
- `scheduled_at` lives on `_create_post` and `_update_post`, NOT on `_publish_post`. Setting it on the draft alone does NOT schedule — you must call `_publish_post`.
- ISO 8601 must include a timezone offset (`'Z'` or `'+/-HH:MM'`). Naive datetimes get rejected.

### Edit a draft, then publish immediately

User intent: "Tighten this draft and post it now."
Steps:
1. `twitter_update_post({ post_id, content })` — replace fields you supply.
2. `twitter_publish_post({ post_id })` — immediate publish (no `scheduled_at` on the draft).
3. Poll `twitter_get_publish_status({ post_id })` until `status: 'published'` or `'failed'`.

### Cancel a scheduled post

User intent: "Don't post that scheduled tweet, I changed my mind."
Steps:
1. `twitter_list_posts({ status: 'scheduled' })` to find the `post_id` if not known.
2. `twitter_cancel_publish({ post_id })` — drops the queued job, status returns to `'draft'`. The post was never sent.
3. (optional) `twitter_delete_post({ post_id })` — only if the user wants the local record gone too.

Watch out:
- `_cancel_publish` only works on `'queued'` or `'scheduled'`. On any other state it returns `{ code: 'invalid_state', current_status, allowed_from }`.
- `_delete_post` only works on `'draft'` or `'failed'`. For queued/scheduled, cancel first.

### Submit a Reddit post to a specific subreddit

User intent: "Submit this to r/learnprogramming with title 'Help with X'."
Steps:
1. `reddit_create_post({ title, content, subreddit: 'learnprogramming' })` — note the subreddit is bare, NO `r/` prefix.
2. `reddit_publish_post({ post_id })`.
3. Poll `reddit_get_publish_status({ post_id })`. Subreddit-specific failures (karma minimum, account age, flair, banned content) surface as `status: 'failed'` with `error_message` — relay that verbatim to the user.

---

## Gmail

### Reply to an email thread

User intent: "Reply to that email from Alice saying we're ready to move ahead."
Modules touched: gmail.

Steps:
1. `gmail_search({ query: 'from:alice@example.com newer_than:14d' })` — finds threads. Returns snippets only.
2. `gmail_get_thread({ thread_id })` — read the full message bodies so the reply has context.
3. `gmail_draft_reply({ to_email, thread_id, body })` — composes locally; NOT sent yet.
4. `gmail_send_draft({ draft_id })` — enqueues for sending.
5. `gmail_get_send_status({ draft_id })` until `'sent'` or `'failed'`.

Watch out:
- `thread_id` is REQUIRED on `gmail_draft_reply` for it to be threaded as a reply in Gmail. Omitting it sends a brand-new email.
- `gmail_delete_draft` cannot delete a draft that has reached `'queued'` (currently being sent) or `'sent'` — those are `{ code: 'invalid_state' }`.

### Save a Gmail thread to the CRM

User intent: "Track this conversation as a lead."
Modules touched: gmail, sheets (or attio).

Steps:
1. `gmail_open_thread({ thread_id, contact_email })` — pins the thread as a workspace output. Returns `output_id`.
2a. (Sheets path) `sheets_append_row({ sheet_id, values: [name, email, ...] })` — appended row auto-publishes a CRM contact output linked to the email column.
2b. (Attio path) `attio_find_people({ query: contact_email })` → if no match, `attio_create_person({ attributes })` → `attio_add_note({ parent_object: 'people', parent_record_id, title, content })`.

Watch out:
- `gmail_open_thread` is idempotent — calling it twice updates the same output.

---

## Sheets

### Update a row by header name (not by index)

User intent: "Mark Alice as 'closed-won' in the contacts sheet."
Steps:
1. `sheets_get_info({ sheet_id })` — learn `headers`. (Skip if you already know them.)
2. `sheets_read_rows({ sheet_id, filter_column: 'name', filter_value: 'Alice' })` — find the row, capture `rowNumber`.
3. `sheets_update_row({ sheet_id, row_number, values: { stage: 'closed-won' }, contact_name: 'Alice', contact_email })` — only the named columns are touched. Pass `contact_name` + `contact_email` to publish a CRM output for the row.

Watch out:
- First DATA row is `2` (row 1 is the header).
- After `sheets_delete_row`, all later row numbers shift by 1 — re-read with `sheets_read_rows` before any further `_update_row` / `_delete_row` on the same sheet.

### Bootstrap a new contacts sheet

User intent: "Create a fresh CRM tracker."
Steps:
1. `sheets_create_spreadsheet({ title: 'CRM Q2', headers: ['name', 'email', 'company', 'stage'] })` — returns the new `spreadsheet_id`.
2. `sheets_append_row({ sheet_id, values: ['Alice', 'a@b.com', 'Acme', 'lead'] })` — auto-publishes a CRM contact output because the sheet has an `email` column.

---

## Cal.com

### Reschedule a meeting

User intent: "Move the meeting with Bob to Thursday at 3pm."
Modules touched: calcom.

Steps:
1. `calcom_list_bookings({ status: 'upcoming', attendee_email: 'bob@x.com' })` — find the booking.
2. `calcom_list_event_types({})` — get the event type's id (needed for the slot check).
3. `calcom_list_available_slots({ event_type_id, start_date, end_date, timezone })` — confirm Thursday 15:00 is free.
4. `calcom_reschedule_booking({ booking_id, new_start_time: '2026-04-30T15:00:00Z', reason: '...' })` — sends the attendee a notification with the reason. Returns a NEW `new_booking_id` — use that for follow-up references, not the original.

Watch out:
- Always call `calcom_get_connection_status({})` if you see `{ code: 'not_connected' }`.
- `new_start_time` must include a timezone offset.

### Cancel an upcoming meeting

User intent: "Cancel my 4pm with Carol."
Steps:
1. `calcom_list_bookings({ status: 'upcoming', attendee_email: 'carol@x.com' })`.
2. `calcom_cancel_booking({ booking_id, reason })`.

Watch out:
- The reason is emailed to the attendee — keep it polite and short.

---

## Attio

### Add a new lead to the CRM and stage them in the pipeline

User intent: "Add Alice from Acme as a lead and put her in 'Q2 Sales' at the discovery stage."
Modules touched: attio.

Steps:
1. `attio_describe_schema({ objects: ['people', 'companies'] })` — learn this workspace's attribute slugs (custom fields differ per workspace).
2. `attio_find_people({ query: 'alice@acme.com' })` — avoid duplicates.
3. (if no match) `attio_find_companies({ query: 'acme.com' })` — find or create the company.
4. (if no company) `attio_create_company({ attributes: { name: 'Acme', domains: ['acme.com'] } })`.
5. `attio_create_person({ attributes: { name: 'Alice', email_addresses: ['alice@acme.com'], job_title: 'CTO' } })`.
6. `attio_link_person_to_company({ person_id, company_id })`.
7. `attio_add_to_list({ list_id: <Q2 Sales>, record_id: person_id, parent_object: 'people', entry_values: { stage: 'discovery' } })`.

Watch out:
- `attio_add_to_list` is an upsert — same call moves an existing entry to a new stage. Don't search-then-add separately.
- `attio_add_to_list.parent_object` must match the `record_id`'s type; mismatch returns `{ code: 'validation_failed' }`.
- Attribute slugs come from `attio_describe_schema`; never hardcode them.

### Move a deal to the next pipeline stage

User intent: "Move Bob to 'demo scheduled' in the sales pipeline."
Steps:
1. `attio_list_records_in_list({ list_id })` — find Bob's entry to confirm `record_id`.
2. `attio_add_to_list({ list_id, record_id, parent_object: 'people', entry_values: { stage: 'demo scheduled' } })` — same tool, upsert behavior moves the stage.

### Log a meeting summary against a contact

User intent: "Add a note to Alice's record with what we discussed."
Steps:
1. `attio_find_people({ query: 'alice' })` → `record_id`.
2. `attio_add_note({ parent_object: 'people', parent_record_id, title: 'Q2 sync', content: '<summary>' })`.

---

## GitHub

### Build a weekly digest of repo activity

User intent: "What's been happening in claude-code this week?"
Steps:
1. `github_recent_activity({ owner: 'anthropics', repo: 'claude-code', days: 7 })` — gets commits, open PRs, latest release, plus a one-line `summary`.
2. (optional) `github_get_pr({ owner, repo, number })` for PRs whose body the user asks about.
3. (optional) `github_get_commit({ owner, repo, sha })` for any commit they want to drill into.

Watch out:
- `github_recent_activity` is the digest entry point — don't list commits / PRs / releases separately first.

---

## Cross-module recipes

### Email follow-up + CRM update + Slack-able summary

User intent: "I just had a call with Alice from Acme. Send her a follow-up, log it in Attio, and save the email to the CRM."

Modules touched: gmail, attio, sheets (or just attio).

Steps:
1. `gmail_draft_reply({ to_email: 'alice@acme.com', subject: 'Great chat today', body, contact_row_ref })` — drafts the follow-up.
2. `gmail_send_draft({ draft_id })`.
3. `attio_find_people({ query: 'alice@acme.com' })` → `record_id`.
4. `attio_add_note({ parent_object: 'people', parent_record_id: record_id, title: 'Discovery call', content })` — captures the meeting summary on the record's timeline.
5. (optional) `gmail_open_thread({ thread_id })` if you want the email pinned as a workspace output.

Watch out:
- Steps 3–5 can run in parallel after step 2 — they don't depend on each other.

### Schedule a meeting + create a CRM task

User intent: "Book a 30-min intro with Bob next Tuesday and remind me to send the deck the day before."

Steps:
1. `calcom_list_event_types({})` → find '30-min intro' event_type_id.
2. `calcom_list_available_slots({ event_type_id, start_date: '2026-04-28', end_date: '2026-04-29' })` → pick a slot.
3. (booking is normally done by the prospect via the booking_url; if user asks to book directly, that's outside this module's scope.)
4. `attio_find_people({ query: 'bob@x.com' })` → `record_id`.
5. `attio_create_task({ content: 'Send Bob the intro deck', deadline_at: '<day-before>T17:00:00Z', linked_records: [{ object: 'people', record_id }] })`.

Watch out:
- This module set does NOT have a "create booking on user's behalf" tool today — share the `booking_url` with the prospect instead.

---

## Maintaining this file

When you add a new tool or change a tool's contract:

1. Update its description per `MCP_TOOL_DESCRIPTION_CONVENTION.md`.
2. Search this file for the tool name. If any recipe uses it, update the recipe.
3. If the tool enables a new workflow no recipe covers, add a recipe — but only if it's a real user request, not a hypothetical.

Recipes that name a deleted / renamed tool are worse than no recipe — they actively mislead the agent.
