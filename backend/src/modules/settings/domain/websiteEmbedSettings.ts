export {
  DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL,
  DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION,
  DEFAULT_WEBSITE_EMBED_SCRIPT_PATH,
  defaultWebsiteEmbedTheme,
  isAllowedWebsiteEmbedOrigin,
  normalizeWebsiteEmbedOrigin,
  websiteEmbedLauncherPositions,
  type WebsiteEmbedCopyPacks,
  type WebsiteEmbedExpertOverrides,
  type WebsiteEmbedLauncherPosition,
  type WebsiteEmbedThemeSettings,
} from "../../../shared/domain/websiteEmbed.js";

import {
  DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL,
  DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION,
  defaultWebsiteEmbedTheme,
  normalizeWebsiteEmbedOrigin,
  type WebsiteEmbedCopyPacks,
  type WebsiteEmbedExpertOverrides,
  type WebsiteEmbedLauncherPosition,
  type WebsiteEmbedThemeSettings,
} from "../../../shared/domain/websiteEmbed.js";

export interface WebsiteEmbedSettingsRecord {
  websiteEmbedEnabled: boolean;
  websiteEmbedToken: string | null;
  websiteEmbedAllowedOrigins: string[];
  websiteEmbedLauncherLabel: string;
  websiteEmbedLauncherPosition: WebsiteEmbedLauncherPosition;
  websiteEmbedTheme: WebsiteEmbedThemeSettings;
  websiteEmbedCopy: WebsiteEmbedCopyPacks;
  websiteEmbedExpertOverrides: WebsiteEmbedExpertOverrides;
}

export interface WebsiteEmbedSettingsInput {
  websiteEmbedEnabled?: boolean;
  websiteEmbedToken?: string | null;
  websiteEmbedAllowedOrigins?: string[];
  websiteEmbedLauncherLabel?: string;
  websiteEmbedLauncherPosition?: WebsiteEmbedLauncherPosition;
  websiteEmbedTheme?: WebsiteEmbedThemeSettings;
  websiteEmbedCopy?: WebsiteEmbedCopyPacks;
  websiteEmbedExpertOverrides?: WebsiteEmbedExpertOverrides;
}

export const defaultWebsiteEmbedSettings = (): WebsiteEmbedSettingsRecord => ({
  websiteEmbedEnabled: false,
  websiteEmbedToken: null,
  websiteEmbedAllowedOrigins: [],
  websiteEmbedLauncherLabel: DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL,
  websiteEmbedLauncherPosition: DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION,
  websiteEmbedTheme: defaultWebsiteEmbedTheme(),
  websiteEmbedCopy: {},
  websiteEmbedExpertOverrides: {},
});

const normalizeLauncherLabel = (value: string | undefined): string => {
  if (value === undefined) {
    return DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL;
  }
  // Empty strings intentionally hide the launcher label while keeping the icon-only launcher active.
  return value.trim().replace(/\s+/g, " ");
};

export const validateWebsiteEmbedSettings = (
  input: WebsiteEmbedSettingsInput,
): WebsiteEmbedSettingsRecord => {
  const defaults = defaultWebsiteEmbedSettings();
  const origins = (input.websiteEmbedAllowedOrigins ?? defaults.websiteEmbedAllowedOrigins)
    .map(normalizeWebsiteEmbedOrigin)
    .filter((origin): origin is string => Boolean(origin));

  const uniqueOrigins = [...new Set(origins)];
  const websiteEmbedEnabled = input.websiteEmbedEnabled ?? defaults.websiteEmbedEnabled;

  if (websiteEmbedEnabled && uniqueOrigins.length === 0) {
    throw new Error("At least one allowed origin is required when website embed is enabled");
  }

  return {
    websiteEmbedEnabled,
    websiteEmbedToken: input.websiteEmbedToken ?? defaults.websiteEmbedToken,
    websiteEmbedAllowedOrigins: uniqueOrigins,
    websiteEmbedLauncherLabel: normalizeLauncherLabel(input.websiteEmbedLauncherLabel),
    websiteEmbedLauncherPosition: input.websiteEmbedLauncherPosition ?? defaults.websiteEmbedLauncherPosition,
    websiteEmbedTheme: input.websiteEmbedTheme ?? defaults.websiteEmbedTheme,
    websiteEmbedCopy: input.websiteEmbedCopy ?? defaults.websiteEmbedCopy,
    websiteEmbedExpertOverrides: input.websiteEmbedExpertOverrides ?? defaults.websiteEmbedExpertOverrides,
  };
};
