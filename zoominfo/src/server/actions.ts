import { createServerFn } from "@tanstack/react-start"
import { clearActions, listRecentActions } from "./audit"

export const loadFeed = createServerFn({ method: "GET" }).handler(async () => {
  return { actions: listRecentActions({ limit: 100 }) }
})

export const fetchRecentActions = createServerFn({ method: "GET" })
  .inputValidator((data: { since?: string; limit?: number }) => data)
  .handler(async ({ data }) => {
    return listRecentActions({ since: data.since, limit: data.limit ?? 100 })
  })

export const clearFeed = createServerFn({ method: "POST" }).handler(async () => {
  const deleted = clearActions()
  return { deleted }
})