/**
 * Holaboss Bridge — re-exports from @holaboss/bridge SDK.
 *
 * Module-local file kept so all internal imports resolve from
 * "./holaboss-bridge" without changing consumer code.
 */

export {
  buildAppResourcePresentation,
  createAppOutput,
  createIntegrationClient,
  publishSessionArtifact,
  resolveHolabossTurnContext,
  updateAppOutput,
} from "@holaboss/bridge"

export type {
  AppOutputPresentationInput,
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
