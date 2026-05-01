import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"

import { ActivityFeed } from "@/components/activity-feed"
import { ConnectionAlert, ConnectionBadge } from "@/components/connection-status"
import type { AgentActionRecord } from "@/lib/types"
import { listRecentActions } from "../server/audit"

const loadFeed = createServerFn({ method: "GET" }).handler(async () => {
  return { actions: listRecentActions({ limit: 100 }) as AgentActionRecord[] }
})

export const Route = createFileRoute("/")({
  loader: async () => loadFeed(),
  component: ApolloHome,
})

function ApolloHome() {
  const { actions } = Route.useLoaderData()
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Apollo</h1>
          <p className="text-sm text-muted-foreground">
            Pure proxy to your Apollo.io account.
          </p>
        </div>
        <ConnectionBadge />
      </header>
      <ConnectionAlert />
      <ActivityFeed initial={actions} />
    </main>
  )
}
