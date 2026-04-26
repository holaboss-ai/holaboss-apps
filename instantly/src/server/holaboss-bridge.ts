/**
 * Holaboss Bridge — re-exports from @holaboss/bridge SDK.
 *
 * Module-local file kept so all internal imports resolve from
 * "./holaboss-bridge" without changing consumer code.
 *
 * DO NOT hand-roll bridge logic in this file. The SDK is the source of truth
 * for broker URL resolution, credential exchange, integration proxying,
 * workspace output publishing, and turn-context extraction. If something is
 * missing from the SDK, fix it upstream in @holaboss/bridge — never inline.
 */

export {
  buildAppResourcePresentation,
  createAppOutput,
  createIntegrationClient,
  publishSessionArtifact,
  resolveHolabossTurnContext,
  syncAppResourceOutput,
  updateAppOutput,
} from "@holaboss/bridge"

export type {
  AppOutputPresentationInput,
  AppResourceOutputInput,
  AppResourceOutputResult,
  CreateAppOutputRequest,
  HolabossTurnContext,
  IntegrationClient,
  ProxyRequest,
  ProxyResponse,
  PublishSessionArtifactRequest,
  SessionArtifactPayload,
  UpdateAppOutputRequest,
  WorkspaceOutputPayload,
} from "@holaboss/bridge"
