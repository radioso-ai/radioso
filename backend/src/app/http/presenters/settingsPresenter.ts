import type { IngestionSettingsRecord } from "../../../modules/settings/contracts/ingestion.js";
import type { PlatformSettingsResource } from "../../../modules/settings/contracts/platform.js";
import type { RetrievalSettingsRecord } from "../../../modules/settings/contracts/retrieval.js";

export const presentIngestionSettings = (
  settings: IngestionSettingsRecord,
  supportedEmbeddingModels: readonly IngestionSettingsRecord["embeddingModel"][],
) => ({
  ...settings,
  supportedEmbeddingModels,
});

export const presentRetrievalSettings = (
  settings: PlatformSettingsResource,
  record: RetrievalSettingsRecord,
) => ({
  ...settings.retrieval,
  workspaceId: record.workspaceId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  suggestedQuestionsEnabled: settings.assistant.suggestedQuestionsEnabled,
  customInstruction: settings.assistant.customInstruction,
});

export const presentGeneralSettings = (
  settings: PlatformSettingsResource,
) => ({
  anonymousChatEnabled: settings.channels.anonymousChatEnabled,
  anonymousChatUrl: settings.channels.anonymousChatUrl,
  assistantName: settings.assistant.assistantName,
  greetingInstruction: settings.assistant.greetingInstruction,
  assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
  proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
  assistantBootstrapActive: settings.assistant.assistantBootstrapActive,
  assistantLogoUrl: settings.assistant.assistantLogoUrl,
  websiteEmbedEnabled: settings.channels.websiteEmbedEnabled,
  websiteEmbedToken: settings.channels.websiteEmbedToken,
  websiteEmbedScriptUrl: settings.channels.websiteEmbedScriptUrl,
  websiteEmbedSnippet: settings.channels.websiteEmbedSnippet,
  websiteEmbedAllowedOrigins: settings.channels.websiteEmbedAllowedOrigins,
  websiteEmbedLauncherLabel: settings.channels.websiteEmbedLauncherLabel,
  websiteEmbedLauncherPosition: settings.channels.websiteEmbedLauncherPosition,
  websiteEmbedTheme: settings.channels.websiteEmbedTheme,
  websiteEmbedCopy: settings.channels.websiteEmbedCopy,
  websiteEmbedExpertOverrides: settings.channels.websiteEmbedExpertOverrides,
});
