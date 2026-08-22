import type {
  EmbeddingModelId,
  IngestionSettingsRecord,
} from "../../../modules/settings/contracts/ingestion.js";
import type {
  MetadataFieldSuggestion,
  RetrievalSettingsRecord,
} from "../../../modules/settings/contracts/retrieval.js";
import type { PlatformSettingsResource } from "../../../modules/settings/contracts/platform.js";
import type { DocumentTypeCatalog } from "../../../modules/documentTypes/contracts/documentTypeCatalog.js";

export const presentIngestionSettings = (
  settings: IngestionSettingsRecord,
  supportedEmbeddingModels: readonly EmbeddingModelId[],
) => ({
  ...settings,
  supportedEmbeddingModels,
});

export const presentGeneralSettings = (
  settings: PlatformSettingsResource,
) => ({
  anonymousChatEnabled: settings.channels.anonymousChatEnabled,
  anonymousChatUrl: settings.channels.anonymousChatUrl,
  anonymousChatLastUsedAt: settings.channels.anonymousChatLastUsedAt,
  assistantName: settings.assistant.assistantName,
  greetingInstruction: settings.assistant.greetingInstruction,
  assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
  proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
  assistantBootstrapActive: settings.assistant.assistantBootstrapActive,
  assistantLogoUrl: settings.assistant.assistantLogoUrl,
  websiteEmbedEnabled: settings.channels.websiteEmbedEnabled,
  websiteEmbedToken: settings.channels.websiteEmbedToken,
  websiteEmbedLastUsedAt: settings.channels.websiteEmbedLastUsedAt,
  websiteEmbedScriptUrl: settings.channels.websiteEmbedScriptUrl,
  websiteEmbedSnippet: settings.channels.websiteEmbedSnippet,
  websiteEmbedAllowedOrigins: settings.channels.websiteEmbedAllowedOrigins,
  websiteEmbedLauncherLabel: settings.channels.websiteEmbedLauncherLabel,
  websiteEmbedLauncherPosition: settings.channels.websiteEmbedLauncherPosition,
  websiteEmbedTheme: settings.channels.websiteEmbedTheme,
  websiteEmbedCopy: settings.channels.websiteEmbedCopy,
  websiteEmbedExpertOverrides: settings.channels.websiteEmbedExpertOverrides,
});

export const presentRetrievalDefaults = (
  settings: RetrievalSettingsRecord,
  metadataFieldSuggestions: MetadataFieldSuggestion[],
) => ({
  queryRewriteEnabled: settings.queryRewriteEnabled,
  temporalStructuredLookupEnabled: settings.temporalStructuredLookupEnabled ?? true,
  temporalBoostUpcomingEnabled: settings.temporalBoostUpcomingEnabled ?? true,
  temporalDeterministicSortEnabled: settings.temporalDeterministicSortEnabled ?? true,
  semanticRewriteInstructions: settings.semanticRewriteInstructions,
  lexicalRewriteInstructions: settings.lexicalRewriteInstructions,
  suggestedQuestionsEnabled: settings.suggestedQuestionsEnabled,
  suggestedQuestionsCount: settings.suggestedQuestionsCount,
  rerankEnabled: settings.rerankEnabled,
  vectorTopK: settings.vectorTopK,
  rerankTopK: settings.rerankTopK,
  retrievalStrategy: settings.retrievalStrategy,
  customInstruction: settings.customInstruction,
  metadataRules: [],
  metadataFieldSuggestions,
});

export const presentDocumentTypeCatalog = (
  catalog: DocumentTypeCatalog,
  referencedFieldKeys: readonly string[] = [],
) => ({
  workspaceId: catalog.workspaceId,
  revision: catalog.revision,
  types: catalog.types.map((type) => ({
    key: type.key,
    label: type.label,
    description: type.description,
    enabled: type.enabled,
    origin: type.origin,
    payload: type.payload,
    disableable: type.disableable,
    fields: type.fields.map((field) => ({
      key: field.key,
      label: field.label,
      valueType: field.valueType,
      instruction: field.instruction,
    })),
  })),
  retiredFields: catalog.retiredFields.map((identity) => ({
    key: identity.key,
    valueType: identity.valueType,
  })),
  // Advisory only: the editor warns before deleting a field some agent's
  // metadata rules still point at, and never blocks the save on it.
  referencedFieldKeys: [...referencedFieldKeys],
});
