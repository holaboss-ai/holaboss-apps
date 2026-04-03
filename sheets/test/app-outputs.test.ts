import test from "node:test"
import assert from "node:assert/strict"
import {
  contactRef,
  contactRoutePath,
  buildContactRowOutputTitle,
  buildContactRowOutputMetadata,
} from "../src/server/app-outputs"

test("contactRef builds composite key", () => {
  assert.equal(contactRef("sheet-1", "Sheet1", 7), "sheet-1:Sheet1:7")
})

test("contactRoutePath encodes the ref", () => {
  assert.equal(contactRoutePath("sheet-1:Sheet1:7"), "/contacts/sheet-1%3ASheet1%3A7")
})

test("buildContactRowOutputTitle includes name and action", () => {
  assert.equal(buildContactRowOutputTitle("Alice Chen", "Updated CRM contact"), "Updated CRM contact: Alice Chen")
})

test("buildContactRowOutputTitle falls back when name is empty", () => {
  assert.equal(buildContactRowOutputTitle("", "Added CRM contact"), "Added CRM contact: contact row")
})

test("buildContactRowOutputMetadata produces the full protocol shape", () => {
  const meta = buildContactRowOutputMetadata({
    ref: "sheet-1:Sheet1:7",
    name: "Alice Chen",
    email: "alice@example.com",
    spreadsheetId: "sheet-1",
    sheetName: "Sheet1",
    rowNumber: 7,
  })

  assert.equal(meta.source_kind, "application")
  const pres = meta.presentation as { kind: string; view: string; path: string }
  assert.equal(pres.kind, "app_resource")
  assert.equal(pres.view, "contacts")
  assert.equal(pres.path, "/contacts/sheet-1%3ASheet1%3A7")

  const resource = meta.resource as { entity_type: string; entity_id: string; label: string }
  assert.equal(resource.entity_type, "contact_row")
  assert.equal(resource.entity_id, "sheet-1:Sheet1:7")
  assert.equal(resource.label, "Alice Chen")

  const crm = meta.crm as { contact_key: string; contact_row_ref: { spreadsheet_id: string; sheet_name: string; row_number: number } }
  assert.equal(crm.contact_key, "alice@example.com")
  assert.equal(crm.contact_row_ref.spreadsheet_id, "sheet-1")
  assert.equal(crm.contact_row_ref.sheet_name, "Sheet1")
  assert.equal(crm.contact_row_ref.row_number, 7)
})

test("buildContactRowOutputMetadata handles null email", () => {
  const meta = buildContactRowOutputMetadata({
    ref: "sheet-1:Sheet1:3",
    name: "Bob",
    email: null,
    spreadsheetId: "sheet-1",
    sheetName: "Sheet1",
    rowNumber: 3,
  })
  const crm = meta.crm as { contact_key: null }
  assert.equal(crm.contact_key, null)
})
