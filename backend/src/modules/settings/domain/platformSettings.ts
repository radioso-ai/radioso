import type {
  AssistantSettingsPatch,
  AssistantSettingsSection,
} from "./assistantSettings.js";
import type {
  MetadataFieldSuggestion,
  RetrievalMetadataRule,
} from "./retrievalSettings.js";
import type {
  WebsiteEmbedLauncherIcon,
  WebsiteEmbedLauncherPosition,
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
  anonymousRateLimit: number;
  websiteEmbedEnabled: boolean;
  websiteEmbedToken: string | null;
  websiteEmbedAllowedOrigins: string[];
  websiteEmbedLauncherLabel: string;
  websiteEmbedLauncherIcon: WebsiteEmbedLauncherIcon;
  websiteEmbedLauncherPosition: WebsiteEmbedLauncherPosition;
  websiteEmbedScriptUrl: string | null;
  websiteEmbedSnippet: string | null;
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
  anonymousRateLimit?: number;
  rotateAnonymousChatToken?: boolean;
  websiteEmbedEnabled?: boolean;
  rotateWebsiteEmbedToken?: boolean;
  websiteEmbedAllowedOrigins?: string[];
  websiteEmbedLauncherLabel?: string;
  websiteEmbedLauncherIcon?: WebsiteEmbedLauncherIcon;
  websiteEmbedLauncherPosition?: WebsiteEmbedLauncherPosition;
}

export interface PlatformSettingsPatch {
  assistant?: AssistantSettingsPatch;
  retrieval?: PlatformRetrievalSettingsPatch;
  channels?: PlatformChannelsSettingsPatch;
}
