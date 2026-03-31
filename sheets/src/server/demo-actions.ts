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
    ["Name", "Email", "Company"],
    [
      ["Alice Chen", profile.email, "Holaboss"],
      ["Bob Smith", "bob@example.com", "Acme Corp"],
      ["Carol Wang", "carol@example.com", "StartupXYZ"],
      ["David Lee", "david@example.com", "TechFlow"],
    ],
  )
  return { sheetId }
})
