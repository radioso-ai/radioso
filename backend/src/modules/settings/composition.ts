export { IngestionSettingsService } from "./services/ingestionSettingsService.js";
// App-wiring entrypoint for the MCP converse surface (composed in app/composition).
export { AgentConverseSessionService } from "./services/agentConverseSessionService.js";
export { embeddingModelIds } from "./domain/ingestionSettings.js";
export { PlatformSettingsService } from "./services/platformSettingsService.js";
export { DefaultWebsiteEmbedIntegrationProvider } from "./domain/websiteEmbedIntegration.js";
export {
  WorkspaceLlmCapabilitySettingsService,
  type WorkspaceLlmCapabilityActor,
} from "./services/workspaceLlmCapabilitySettingsService.js";
export {
  workspaceLlmCapabilities,
  type WorkspaceLlmCapability,
  type WorkspaceLlmCapabilityPreference,
  type WorkspaceLlmCapabilityPreferenceInput,
} from "./contracts/llmCapability.js";
export type {
  EmbeddingModelTransitionFailureReason,
  EmbeddingModelTransitionPort,
  EmbeddingModelTransitionReadiness,
  EmbeddingModelTransitionState,
  EmbeddingModelTransitionStatus,
  IngestionSettingsRepositoryPort,
  RetrievalMetadataFieldSourcePort,
  WorkspaceLlmCapabilityPreferencesRepositoryPort,
} from "./contracts/services.js";
