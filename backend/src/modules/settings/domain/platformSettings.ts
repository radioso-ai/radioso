import type {
  AssistantSettingsPatch,
  AssistantSettingsSection,
} from "./assistantSettings.js";
import type {
  WebsiteEmbedLauncherPosition,
  WebsiteEmbedThemeSettings,
  WebsiteEmbedCopyPacks,
  WebsiteEmbedExpertOverrides,
} from "./websiteEmbedSettings.js";

export interface PlatformChannelsSettingsSection {
  anonymousChatEnabled: boolean;
  anonymousChatUrl: string | null;
  anonymousChatLastUsedAt: string | null;
  websiteEmbedEnabled: boolean;
  websiteEmbedToken: string | null;
  websiteEmbedLastUsedAt: string | null;
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
  channels: PlatformChannelsSettingsSection;
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
  channels?: PlatformChannelsSettingsPatch;
}
