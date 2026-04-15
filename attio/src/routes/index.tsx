import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { listRecentActions } from "../server/audit"
import { ConnectionStatusBar } from "../components/connection-status-bar"
import { SearchShortcut } from "../components/search-shortcut"
import { ActivityFeed } from "../components/activity-feed"
import type { AgentActionRecord } from "../lib/types"

const loadFeed = createServerFn({ method: "GET" }).handler(async () => {
  return { actions: listRecentActions({ limit: 100 }) as AgentActionRecord[] }
})

export const Route = createFileRoute("/")({
  loader: async () => loadFeed(),
  component: AttioHome,
})

function AttioHome() {
  const { actions } = Route.useLoaderData()
  return (
    <main className="mx-auto min-h-screen max-w-5xl">
      <header className="px-6 pt-8 pb-2">
        <h1 className="text-xl font-semibold">Attio CRM</h1>
        <p className="text-sm text-muted-foreground">Agent activity feed · pure proxy to your Attio workspace</p>
      </header>
      <ConnectionStatusBar />
      <SearchShortcut />
      <ActivityFeed initial={actions} />
    </main>
  )
}