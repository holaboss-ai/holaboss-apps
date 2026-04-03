import { createServerFn } from "@tanstack/react-start"

import { getUserProfile, listEmails, getEmail, sendEmail } from "./gmail-api"
import { getSheetInfo, readRows, createSpreadsheet } from "./google-api"

export const fetchProfile = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await getUserProfile()
  } catch {
    return null
  }
})

export const fetchContacts = createServerFn({ method: "GET" })
  .inputValidator((data: { sheetId: string }) => data)
  .handler(async ({ data }) => {
    const info = await getSheetInfo(data.sheetId)
    const rows = await readRows(data.sheetId)
    return { info, rows }
  })

export const fetchEmailsForContact = createServerFn({ method: "GET" })
  .inputValidator((data: { email: string }) => data)
  .handler(async ({ data }) => {
    return await listEmails(10, `from:${data.email} OR to:${data.email}`)
  })

export const fetchEmailDetail = createServerFn({ method: "GET" })
  .inputValidator((data: { messageId: string }) => data)
  .handler(async ({ data }) => {
    return await getEmail(data.messageId)
  })

export const doSendEmail = createServerFn({ method: "POST" })
  .inputValidator((data: { to: string; subject: string; body: string }) => data)
  .handler(async ({ data }) => {
    await sendEmail(data.to, data.subject, data.body)
    return { sent: true }
  })

export const createSampleSheet = createServerFn({ method: "POST" }).handler(async () => {
  const profile = await getUserProfile()
  const sheetId = await createSpreadsheet(
    "Contacts",
    ["Name", "Email", "Company", "Stage", "Owner", "Last Contacted At", "Next Action"],
    [
      ["Alice Chen", profile.email, "Holaboss", "Qualified", "You", "2026-04-02", "Send pricing follow-up"],
      ["Bob Smith", "bob@example.com", "Acme Corp", "New", "Ava", "2026-03-30", "Research recent thread"],
      ["Carol Wang", "carol@example.com", "StartupXYZ", "Nurturing", "Mia", "2026-03-28", "Draft follow-up email"],
      ["David Lee", "david@example.com", "TechFlow", "Active", "Noah", "2026-04-01", "Confirm next meeting"],
    ],
  )
  return { sheetId }
})
