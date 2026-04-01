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
})
