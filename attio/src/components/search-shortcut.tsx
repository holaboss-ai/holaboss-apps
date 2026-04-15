import { useEffect, useState } from "react"
import type { AttioRecord } from "../lib/types"

interface SearchResponse {
  people: AttioRecord[]
  companies: AttioRecord[]
}

export function SearchShortcut() {
  const [query, setQuery] = useState("")
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!query.trim()) {
      setResult(null)
      setError(null)
      return
    }
    const handle = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        })
        if (r.ok) {
          const data = (await r.json()) as SearchResponse
          setResult(data)
        } else {
          setError("Search failed")
        }
      } catch {
        setError("Search failed")
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(handle)
  }, [query])

  function extractName(record: AttioRecord): string {
    const v = record.values
    const nameField = v.name
    if (Array.isArray(nameField) && nameField[0]) {
      const first = nameField[0] as Record<string, unknown>
      return String(first.full_name ?? first.value ?? record.id)
    }
    return record.id
  }

  function extractSecondary(record: AttioRecord, kind: "person" | "company"): string {
    if (kind === "person") {
      const emails = record.values.email_addresses
      if (Array.isArray(emails) && emails[0]) {
        return String((emails[0] as Record<string, unknown>).email_address ?? emails[0])
      }
    } else {
      const domains = record.values.domains
      if (Array.isArray(domains) && domains[0]) {
        return String((domains[0] as Record<string, unknown>).domain ?? domains[0])
      }
    }
    return ""
  }

  return (
    <div className="border-b border-border px-6 py-4">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people or companies in Attio…"
        className="w-full rounded-md border border-input bg-background px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {loading && <div className="mt-2 text-xs text-muted-foreground">Searching…</div>}
      {error && <div className="mt-2 text-xs text-destructive">{error} · retry</div>}
      {result && !loading && !error && (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">People</div>
            {result.people.length === 0 ? (
              <div className="text-xs text-muted-foreground">No matches</div>
            ) : (
              <ul className="space-y-2">
                {result.people.map((p) => (
                  <li key={p.id} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <div className="font-medium text-foreground">{extractName(p)}</div>
                    <div className="text-xs text-muted-foreground">{extractSecondary(p, "person")}</div>
                    <a
                      href={`https://app.attio.com/records/people/${p.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      Open in Attio →
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Companies</div>
            {result.companies.length === 0 ? (
              <div className="text-xs text-muted-foreground">No matches</div>
            ) : (
              <ul className="space-y-2">
                {result.companies.map((c) => (
                  <li key={c.id} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <div className="font-medium text-foreground">{extractName(c)}</div>
                    <div className="text-xs text-muted-foreground">{extractSecondary(c, "company")}</div>
                    <a
                      href={`https://app.attio.com/records/companies/${c.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      Open in Attio →
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}