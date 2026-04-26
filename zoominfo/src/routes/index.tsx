import { createFileRoute } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { listRecentActions } from "../server/audit"
import { ConnectionStatusBar } from "../components/connection-status-bar"
import { ActivityFeed } from "../components/activity-feed"

const loadFeed = createServerFn({ method: "GET" }).handler(async () => {
  return { actions: listRecentActions({ limit: 100 }) }
})

export const Route = createFileRoute("/")({
  loader: async () => loadFeed(),
  component: ZoomInfoHome,
})

function ZoomInfoHome() {
  const { actions } = Route.useLoaderData()
  return (
    <main className="mx-auto min-h-screen max-w-5xl">
      <header className="px-6 pt-8 pb-2">
        <h1 className="text-xl font-semibold">ZoomInfo</h1>
        <p className="text-sm text-muted-foreground">
          Agent activity feed · read-only B2B intelligence (data licensed from ZoomInfo)
        </p>
      </header>
      <ConnectionStatusBar />
      <ActivityFeed initial={actions} />
    </main>
  )
}
