import { describe, expect, it } from "vitest"
import { buildFuzzyPeopleQuery, buildFuzzyCompaniesQuery } from "../../src/server/query-builder"

describe("buildFuzzyPeopleQuery", () => {
  it("produces a compound OR filter on name and email", () => {
    const body = buildFuzzyPeopleQuery("alice", 20)
    expect(body.limit).toBe(20)
    expect(body.filter).toEqual({
      $or: [
        { name: { $contains: "alice" } },
        { email_addresses: { $contains: "alice" } },
      ],
    })
  })

  it("defaults limit to 20", () => {
    const body = buildFuzzyPeopleQuery("alice")
    expect(body.limit).toBe(20)
  })

  it("trims whitespace from query", () => {
    const body = buildFuzzyPeopleQuery("  alice  ")
    expect(body.filter.$or[0].name.$contains).toBe("alice")
  })
})

describe("buildFuzzyCompaniesQuery", () => {
  it("produces a compound OR filter on name and domain", () => {
    const body = buildFuzzyCompaniesQuery("acme", 10)
    expect(body.limit).toBe(10)
    expect(body.filter).toEqual({
      $or: [
        { name: { $contains: "acme" } },
        { domains: { $contains: "acme" } },
      ],
    })
  })
})