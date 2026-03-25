import { createFileRoute } from "@tanstack/react-router"
import { fetchStatus } from "../server/actions"

export const Route = createFileRoute("/")({
  component: SheetsPage,
  loader: () => fetchStatus(),
})

function SheetsPage() {
  const status = Route.useLoaderData()
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Google Sheets</h1>
        <p className="text-sm text-muted-foreground">Read and write Google Sheets data. Use the agent to query rows, update cells, and append data.</p>
      </div>
      <div className="rounded-lg border border-border px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">{status.message}</p>
      </div>
    </div>
  )
}
