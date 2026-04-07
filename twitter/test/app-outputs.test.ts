import { afterEach, describe, expect, it, vi } from "vitest"

const ORIGINAL_ENV = {
  WORKSPACE_API_URL: process.env.WORKSPACE_API_URL,
  HOLABOSS_WORKSPACE_ID: process.env.HOLABOSS_WORKSPACE_ID,
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  if (ORIGINAL_ENV.WORKSPACE_API_URL === undefined) {
    delete process.env.WORKSPACE_API_URL
  } else {
    process.env.WORKSPACE_API_URL = ORIGINAL_ENV.WORKSPACE_API_URL
  }
  if (ORIGINAL_ENV.HOLABOSS_WORKSPACE_ID === undefined) {
    delete process.env.HOLABOSS_WORKSPACE_ID
  } else {
    process.env.HOLABOSS_WORKSPACE_ID = ORIGINAL_ENV.HOLABOSS_WORKSPACE_ID
  }
})

function makePost(overrides: Partial<import("../src/lib/types").PostRecord> = {}): import("../src/lib/types").PostRecord {
  return {
    id: "post-42",
    content: "Hello world",
    status: "draft",
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    output_id: null,
    ...overrides,
  }
}

const TURN_CONTEXT = {
  workspaceId: "workspace-1",
  sessionId: "session-99",
  inputId: "input-42",
}

function setupPublishingEnv() {
  process.env.WORKSPACE_API_URL = "http://127.0.0.1:4567/api/v1"
  process.env.HOLABOSS_WORKSPACE_ID = "workspace-1"
}

function mockArtifactResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      artifact: {
        id: "artifact-1",
        output_id: "output-1",
        session_id: "session-99",
        workspace_id: "workspace-1",
        input_id: "input-42",
        artifact_type: "draft",
        external_id: "post-42",
        platform: "twitter",
        title: "Hello world",
        metadata: {
          presentation: {
            kind: "app_resource",
            view: "posts",
            path: "/posts/post-42",
          },
        },
        created_at: "2026-04-01T00:00:00.000Z",
        ...overrides,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

describe("Twitter app outputs", () => {
  it("publishes post drafts as session artifacts with post routes", async () => {
    setupPublishingEnv()

    const fetchMock = vi.fn().mockResolvedValueOnce(mockArtifactResponse())
    vi.stubGlobal("fetch", fetchMock)

    const { syncPostDraftArtifact } = await import("../src/server/app-outputs")
    const outputId = await syncPostDraftArtifact(makePost(), TURN_CONTEXT)

    expect(outputId).toBe("output-1")
    const [, init] = fetchMock.mock.calls[0]!
    expect(String(init?.body ?? "")).toContain("\"path\":\"/posts/post-42\"")
  })

  it("updates existing output when output_id is already set", async () => {
    setupPublishingEnv()

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            id: "existing-output",
            workspace_id: "workspace-1",
            output_type: "draft",
            title: "Hello world",
            status: "draft",
            module_id: "twitter",
            module_resource_id: "post-42",
            metadata: {},
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { syncPostDraftArtifact } = await import("../src/server/app-outputs")
    const outputId = await syncPostDraftArtifact(
      makePost({ output_id: "existing-output" }),
      TURN_CONTEXT,
    )

    expect(outputId).toBe("existing-output")
    const [url] = fetchMock.mock.calls[0]!
    expect(url).toContain("/outputs/existing-output")
  })

  it("resolveHolabossTurnContext returns null when session header is missing", async () => {
    const { resolveHolabossTurnContext } = await import("../src/server/holaboss-bridge")

    expect(resolveHolabossTurnContext(null)).toBeNull()
    expect(resolveHolabossTurnContext({})).toBeNull()
    expect(resolveHolabossTurnContext({ "x-holaboss-workspace-id": "ws-1" })).toBeNull()
  })

  it("resolveHolabossTurnContext extracts context from valid headers", async () => {
    const { resolveHolabossTurnContext } = await import("../src/server/holaboss-bridge")

    const ctx = resolveHolabossTurnContext({
      "x-holaboss-workspace-id": "ws-1",
      "x-holaboss-session-id": "sess-1",
      "x-holaboss-input-id": "inp-1",
    })

    expect(ctx).toEqual({
      workspaceId: "ws-1",
      sessionId: "sess-1",
      inputId: "inp-1",
    })
  })
})
