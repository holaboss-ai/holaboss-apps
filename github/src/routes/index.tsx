import { createFileRoute } from "@tanstack/react-router"
import { fetchStatus } from "../server/actions"

export const Route = createFileRoute("/")({
  component: GitHubPage,
  loader: () => fetchStatus(),
})

function GitHubPage() {
  const status = Route.useLoaderData()
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">GitHub</h1>
        <p className="text-sm text-muted-foreground">{status.message}</p>
      </div>
      <div className="rounded-lg border border-border px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">Connected. Ask the agent to check your repos, commits, or releases.</p>
      </div>
    </div>
  )
}
