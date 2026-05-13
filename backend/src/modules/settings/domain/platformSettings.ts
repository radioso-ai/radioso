import type {
  AssistantSettingsPatch,
  AssistantSettingsSection,
} from "./assistantSettings.js";
import type {
  MetadataFieldSuggestion,
  RetrievalMetadataRule,
} from "./retrievalSettings.js";
import type {
  WebsiteEmbedLauncherPosition,
  WebsiteEmbedThemeSettings,
  WebsiteEmbedCopyPacks,
  WebsiteEmbedExpertOverrides,
} from "./websiteEmbedSettings.js";

export interface PlatformRetrievalSettingsSection {
  queryRewriteEnabled: boolean;
  semanticRewriteInstructions: string;
  lexicalRewriteInstructions: string;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  citationDisplayEnabled: boolean;
  answerSupportValidationEnabled: boolean;
  metadataRules: RetrievalMetadataRule[];
  metadataFieldSuggestions: MetadataFieldSuggestion[];
}

export interface PlatformChannelsSettingsSection {
  anonymousChatEnabled: boolean;
  anonymousChatUrl: string | null;
  websiteEmbedEnabled: boolean;
  websiteEmbedToken: string | null;
  websiteEmbedAllowedOrigins: string[];
  websiteEmbedLauncherLabel: string;
  websiteEmbedLauncherPosition: WebsiteEmbedLauncherPosition;
  websiteEmbedScriptUrl: string | null;
  websiteEmbedSnippet: string | null;
  websiteEmbedTheme: WebsiteEmbedThemeSettings;
  websiteEmbedCopy: WebsiteEmbedCopyPacks;
  websiteEmbedExpertOverrides: WebsiteEmbedExpertOverrides;
}

export interface PlatformSettingsResource {
  assistant: AssistantSettingsSection;
  retrieval: PlatformRetrievalSettingsSection;
  channels: PlatformChannelsSettingsSection;
}

export interface PlatformRetrievalSettingsPatch {
  queryRewriteEnabled?: boolean;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  rerankEnabled?: boolean;
  vectorTopK?: number;
  similarityThreshold?: number;
  rerankTopK?: number;
  citationDisplayEnabled?: boolean;
  answerSupportValidationEnabled?: boolean;
  metadataRules?: RetrievalMetadataRule[];
}

export interface PlatformChannelsSettingsPatch {
  anonymousChatEnabled?: boolean;
  rotateAnonymousChatToken?: boolean;
  websiteEmbedEnabled?: boolean;
  rotateWebsiteEmbedToken?: boolean;
  websiteEmbedAllowedOrigins?: string[];
  websiteEmbedLauncherLabel?: string;
  websiteEmbedLauncherPosition?: WebsiteEmbedLauncherPosition;
  websiteEmbedTheme?: WebsiteEmbedThemeSettings;
  websiteEmbedCopy?: WebsiteEmbedCopyPacks;
  websiteEmbedExpertOverrides?: WebsiteEmbedExpertOverrides;
}

export interface PlatformSettingsPatch {
  assistant?: AssistantSettingsPatch;
  retrieval?: PlatformRetrievalSettingsPatch;
  channels?: PlatformChannelsSettingsPatch;
}
