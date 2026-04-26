import { createServerFn } from "@tanstack/react-start"
import { listRecentActions, clearActions } from "./audit"
import type { AgentActionRecord } from "../lib/types"

export const loadFeed = createServerFn({ method: "GET" }).handler(async () => {
  return { actions: listRecentActions({ limit: 100 }) as AgentActionRecord[] }
})

export const fetchRecentActions = createServerFn({ method: "GET" })
  .inputValidator((data: { since?: string; limit?: number }) => data)
  .handler(async ({ data }) => {
    return listRecentActions({ since: data.since, limit: data.limit ?? 100 }) as AgentActionRecord[]
  })

export const clearFeed = createServerFn({ method: "POST" }).handler(async () => {
  const deleted = clearActions()
  return { deleted }
})
