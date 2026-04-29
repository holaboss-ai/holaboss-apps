import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const proxyMock = vi.fn()
vi.mock("../src/server/holaboss-bridge", () => ({
  createIntegrationClient: () => ({ proxy: proxyMock }),
}))

const ORIGINAL_ENV = {
  WORKSPACE_DB_PATH: process.env.WORKSPACE_DB_PATH,
  DB_PATH: process.env.DB_PATH,
}

let scratchDir = ""
let prevCwd = ""

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "reddit-tracking-"))
  mkdirSync(scratchDir, { recursive: true })
  prevCwd = process.cwd()
  process.chdir(scratchDir)
  delete process.env.WORKSPACE_DB_PATH
  process.env.DB_PATH = join(scratchDir, "test.db")
  vi.resetModules()
  proxyMock.mockReset()
})

afterEach(() => {
  process.chdir(prevCwd)
  rmSync(scratchDir, { recursive: true, force: true })
  if (ORIGINAL_ENV.WORKSPACE_DB_PATH === undefined) {
    delete process.env.WORKSPACE_DB_PATH
  } else {
    process.env.WORKSPACE_DB_PATH = ORIGINAL_ENV.WORKSPACE_DB_PATH
  }
  if (ORIGINAL_ENV.DB_PATH === undefined) {
    delete process.env.DB_PATH
  } else {
    process.env.DB_PATH = ORIGINAL_ENV.DB_PATH
  }
})

describe("parseRedditUrl", () => {
  it.each([
    [
      "https://www.reddit.com/r/programming/comments/abc123/some_slug/",
      { external_post_id: "abc123", subreddit_from_url: "programming" },
    ],
    [
      "https://reddit.com/r/dataisbeautiful/comments/xyz789",
      { external_post_id: "xyz789", subreddit_from_url: "dataisbeautiful" },
    ],
    [
      "https://old.reddit.com/r/golang/comments/qwert/?sort=new",
      { external_post_id: "qwert", subreddit_from_url: "golang" },
    ],
    [
      "https://redd.it/abc123",
      { external_post_id: "abc123", subreddit_from_url: null },
    ],
    [
      "t3_abc123",
      { external_post_id: "abc123", subreddit_from_url: null },
    ],
    [
      "abc123",
      { external_post_id: "abc123", subreddit_from_url: null },
    ],
  ])("parses %s", async (input, expected) => {
    const { parseRedditUrl } = await import("../src/server/tracking")
    const parsed = parseRedditUrl(input)
    expect(parsed).not.toBeNull()
    expect(parsed!.external_post_id).toBe(expected.external_post_id)
    expect(parsed!.subreddit_from_url).toBe(expected.subreddit_from_url)
  })

  it("returns null for non-Reddit URLs", async () => {
    const { parseRedditUrl } = await import("../src/server/tracking")
    expect(parseRedditUrl("https://example.com/foo")).toBeNull()
    expect(parseRedditUrl("")).toBeNull()
    expect(parseRedditUrl("not a url")).toBeNull()
  })
})

describe("trackPost", () => {
  it("registers a post with subreddit + title from upstream", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                id: "abc123",
                subreddit: "programming",
                title: "Hello world",
                created_utc: 1714000000,
                permalink: "/r/programming/comments/abc123/hello/",
              },
            },
          ],
        },
      },
      headers: {},
    })

    const { trackPost } = await import("../src/server/tracking")
    const result = await trackPost({
      url: "https://www.reddit.com/r/programming/comments/abc123/hello/",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.subreddit).toBe("programming")
    expect(result.data.title).toBe("Hello world")
    expect(result.data.external_post_id).toBe("abc123")
    expect(result.data.published_at).toBe(
      new Date(1714000000 * 1000).toISOString(),
    )
    expect(result.data.already_tracked).toBe(false)
  })

  it("is idempotent — second call returns already_tracked=true", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                id: "abc123",
                subreddit: "programming",
                title: "Hi",
                created_utc: 1714000000,
                permalink: "/r/programming/comments/abc123/hi/",
              },
            },
          ],
        },
      },
      headers: {},
    })
    const { trackPost } = await import("../src/server/tracking")
    const first = await trackPost({
      url: "https://www.reddit.com/r/programming/comments/abc123/hi/",
    })
    expect(first.ok).toBe(true)

    const second = await trackPost({
      url: "https://www.reddit.com/r/programming/comments/abc123/hi/",
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.already_tracked).toBe(true)
  })

  it("rejects unparseable URLs without hitting the upstream", async () => {
    const { trackPost } = await import("../src/server/tracking")
    const result = await trackPost({ url: "https://example.com/nope" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("validation_failed")
    expect(proxyMock).not.toHaveBeenCalled()
  })

  it("recovers subreddit from API for redd.it short links", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                id: "abc123",
                subreddit: "machinelearning",
                title: "Hi",
                created_utc: 1714000000,
              },
            },
          ],
        },
      },
      headers: {},
    })
    const { trackPost } = await import("../src/server/tracking")
    const result = await trackPost({ url: "https://redd.it/abc123" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.subreddit).toBe("machinelearning")
  })

  it("returns not_found when upstream has no children", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: { data: { children: [] } },
      headers: {},
    })
    const { trackPost } = await import("../src/server/tracking")
    const result = await trackPost({
      url: "https://www.reddit.com/r/programming/comments/zzz/",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("not_found")
  })
})

describe("setPostViews", () => {
  it("updates views and returns the new value", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                id: "abc123",
                subreddit: "programming",
                title: "Hi",
                created_utc: 1714000000,
                permalink: "/r/programming/comments/abc123/hi/",
              },
            },
          ],
        },
      },
      headers: {},
    })
    const { trackPost, setPostViews } = await import("../src/server/tracking")
    const tracked = await trackPost({
      url: "https://www.reddit.com/r/programming/comments/abc123/hi/",
    })
    expect(tracked.ok).toBe(true)
    if (!tracked.ok) return

    const updated = setPostViews({ post_id: tracked.data.post_id, views: 12345 })
    expect(updated).not.toBeNull()
    expect(updated?.views).toBe(12345)
  })

  it("returns null when post_id doesn't exist", async () => {
    const { setPostViews } = await import("../src/server/tracking")
    expect(setPostViews({ post_id: "nope", views: 1 })).toBeNull()
  })

  it("rejects negative views", async () => {
    const { setPostViews } = await import("../src/server/tracking")
    expect(() => setPostViews({ post_id: "any", views: -5 })).toThrow()
  })
})
