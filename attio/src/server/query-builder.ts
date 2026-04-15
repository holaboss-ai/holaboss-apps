export interface QueryBody {
  limit: number
  filter: {
    $or: Array<Record<string, { $contains: string }>>
  }
}

export function buildFuzzyPeopleQuery(query: string, limit = 20): QueryBody {
  const q = query.trim()
  return {
    limit,
    filter: {
      $or: [
        { name: { $contains: q } },
        { email_addresses: { $contains: q } },
      ],
    },
  }
}

export function buildFuzzyCompaniesQuery(query: string, limit = 20): QueryBody {
  const q = query.trim()
  return {
    limit,
    filter: {
      $or: [
        { name: { $contains: q } },
        { domains: { $contains: q } },
      ],
    },
  }
}
