import type { IngestionSettingsRecord } from "../../../modules/settings/contracts/ingestion.js";
import type {
  MetadataFieldSuggestion,
  RetrievalSettingsRecord,
} from "../../../modules/settings/contracts/retrieval.js";
import type { PlatformSettingsResource } from "../../../modules/settings/contracts/platform.js";

export const presentIngestionSettings = (
  settings: IngestionSettingsRecord,
  supportedEmbeddingModels: readonly IngestionSettingsRecord["embeddingModel"][],
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
