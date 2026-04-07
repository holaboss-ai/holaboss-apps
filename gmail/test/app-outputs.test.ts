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

describe("Holaboss bridge app outputs", () => {
  it("publishes a draft artifact against the active session turn", async () => {
    process.env.WORKSPACE_API_URL = "http://127.0.0.1:4567/api/v1"
    process.env.HOLABOSS_WORKSPACE_ID = "workspace-1"

    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          artifact: {
            id: "artifact-1",
            output_id: "output-1",
            session_id: "session-99",
            workspace_id: "workspace-1",
            input_id: "input-42",
            artifact_type: "draft",
            external_id: "draft-42",
            platform: "google",
            title: "Follow up",
            metadata: {
              presentation: {
                kind: "app_resource",
                view: "drafts",
                path: "/drafts/draft-42",
              },
            },
            created_at: "2026-04-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const {
      buildAppResourcePresentation,
      publishSessionArtifact,
    } = await import("../src/server/holaboss-bridge")

    const artifact = await publishSessionArtifact(
      {
        workspaceId: "workspace-1",
        sessionId: "session-99",
        inputId: "input-42",
      },
      {
        artifactType: "draft",
        externalId: "draft-42",
        title: "Follow up",
        moduleId: "gmail",
        moduleResourceId: "draft-42",
        platform: "google",
        metadata: {
          presentation: buildAppResourcePresentation({
            view: "drafts",
            path: "/drafts/draft-42",
          }),
        },
      },
    )

    expect(artifact?.output_id).toBe("output-1")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [createUrl, createInit] = fetchMock.mock.calls[0]!
    expect(createUrl).toBe("http://127.0.0.1:4567/api/v1/agent-sessions/session-99/artifacts")
    expect((createInit?.headers as Record<string, string>)["x-holaboss-workspace-id"]).toBe("workspace-1")
    expect(String(createInit?.body ?? "")).toContain("\"input_id\":\"input-42\"")
    expect(String(createInit?.body ?? "")).toContain("\"module_id\":\"gmail\"")
    expect(String(createInit?.body ?? "")).toContain("\"module_resource_id\":\"draft-42\"")
  })

  it("creates and normalizes an app output with presentation metadata", async () => {
    process.env.WORKSPACE_API_URL = "http://127.0.0.1:4567/api/v1"
    process.env.HOLABOSS_WORKSPACE_ID = "workspace-1"

    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            id: "output-1",
            workspace_id: "workspace-1",
            output_type: "draft",
            title: "Follow up",
            status: "draft",
            module_id: "gmail",
            module_resource_id: "draft-42",
            file_path: null,
            html_content: null,
            session_id: null,
            artifact_id: null,
            folder_id: null,
            platform: "google",
            metadata: {},
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            id: "output-1",
            workspace_id: "workspace-1",
            output_type: "draft",
            title: "Follow up",
            status: "ready",
            module_id: "gmail",
            module_resource_id: "draft-42",
            file_path: null,
            html_content: null,
            session_id: null,
            artifact_id: null,
            folder_id: null,
            platform: "google",
            metadata: {
              presentation: {
                kind: "app_resource",
                view: "drafts",
                path: "/drafts/draft-42",
              },
            },
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { createAppOutput, buildAppResourcePresentation } = await import("../src/server/holaboss-bridge")
    const output = await createAppOutput({
      outputType: "draft",
      title: "Follow up",
      moduleId: "gmail",
      moduleResourceId: "draft-42",
      platform: "google",
      status: "ready",
      metadata: {
        presentation: buildAppResourcePresentation({
          view: "drafts",
          path: "/drafts/draft-42",
        }),
      },
    })

    expect(output?.status).toBe("ready")
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [createUrl, createInit] = fetchMock.mock.calls[0]!
    expect(createUrl).toBe("http://127.0.0.1:4567/api/v1/outputs")
    expect((createInit?.headers as Record<string, string>)["x-holaboss-workspace-id"]).toBe("workspace-1")

    const [patchUrl, patchInit] = fetchMock.mock.calls[1]!
    expect(patchUrl).toBe("http://127.0.0.1:4567/api/v1/outputs/output-1")
    expect(String(patchInit?.body ?? "")).toContain("\"status\":\"ready\"")
  })

  it("builds crm-linked thread output metadata for reopenable thread surfaces", async () => {
    const {
      buildThreadOutputMetadata,
      buildThreadOutputTitle,
      threadRoutePath,
    } = await import("../src/server/app-outputs")

    expect(threadRoutePath("thread-42")).toBe("/threads/thread-42")
    expect(
      buildThreadOutputTitle({
        threadId: "thread-42",
        subject: "Quarterly follow-up",
        primaryEmail: "alice@example.com",
      }),
    ).toBe("Quarterly follow-up")

    expect(
      buildThreadOutputMetadata({
        threadId: "thread-42",
        subject: "Quarterly follow-up",
        primaryEmail: "Alice@Example.com",
        contactRowRef: "sheet-1:Sheet1:7",
      }),
    ).toMatchObject({
      source_kind: "application",
      presentation: {
        kind: "app_resource",
        view: "threads",
        path: "/threads/thread-42",
      },
      resource: {
        entity_type: "thread",
        entity_id: "thread-42",
        label: "Quarterly follow-up",
      },
      crm: {
        contact_key: "alice@example.com",
        primary_email: "Alice@Example.com",
        contact_row_ref: "sheet-1:Sheet1:7",
      },
    })
  })
})
