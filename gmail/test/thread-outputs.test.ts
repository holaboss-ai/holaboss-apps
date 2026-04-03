import test from "node:test"
import assert from "node:assert/strict"

test("builds crm-linked thread output metadata for reopenable thread surfaces", async () => {
  const {
    buildThreadOutputMetadata,
    buildThreadOutputTitle,
    threadRoutePath,
  } = await import("../src/server/app-outputs")

  assert.equal(threadRoutePath("thread-42"), "/threads/thread-42")
  assert.equal(
    buildThreadOutputTitle({
      threadId: "thread-42",
      subject: "Quarterly follow-up",
      primaryEmail: "alice@example.com",
    }),
    "Quarterly follow-up",
  )

  assert.deepEqual(
    buildThreadOutputMetadata({
      threadId: "thread-42",
      subject: "Quarterly follow-up",
      primaryEmail: "Alice@Example.com",
      contactRowRef: "sheet-1:Sheet1:7",
    }),
    {
      source_kind: "application",
      presentation: {
        kind: "app_resource",
        view: "threads",
        path: "/threads/thread-42",
      },
      resource: {
        entity_type: "thread",
        entity_id: "thread-42",
        label: "Quarterly follow-up",
      },
      crm: {
        contact_key: "alice@example.com",
        primary_email: "Alice@Example.com",
        contact_row_ref: "sheet-1:Sheet1:7",
      },
    },
  )
})
