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

const normalizeWebsiteEmbedSettings = (
  input: WebsiteEmbedSettingsInput,
): WebsiteEmbedSettingsRecord => {
  const defaults = defaultWebsiteEmbedSettings();
  const origins = (input.websiteEmbedAllowedOrigins ?? defaults.websiteEmbedAllowedOrigins)
    .map(normalizeWebsiteEmbedOrigin)
    .filter((origin): origin is string => Boolean(origin));

  return {
    websiteEmbedEnabled: input.websiteEmbedEnabled ?? defaults.websiteEmbedEnabled,
    websiteEmbedToken: input.websiteEmbedToken ?? defaults.websiteEmbedToken,
    websiteEmbedAllowedOrigins: [...new Set(origins)],
    websiteEmbedLauncherLabel: normalizeLauncherLabel(input.websiteEmbedLauncherLabel),
    websiteEmbedLauncherPosition: input.websiteEmbedLauncherPosition ?? defaults.websiteEmbedLauncherPosition,
    websiteEmbedTheme: input.websiteEmbedTheme ?? defaults.websiteEmbedTheme,
    websiteEmbedCopy: input.websiteEmbedCopy ?? defaults.websiteEmbedCopy,
    websiteEmbedExpertOverrides: input.websiteEmbedExpertOverrides ?? defaults.websiteEmbedExpertOverrides,
  };
};

// Write path: reject caller input that would persist an unusable embed.
export const validateWebsiteEmbedSettings = (
  input: WebsiteEmbedSettingsInput,
): WebsiteEmbedSettingsRecord => {
  const normalized = normalizeWebsiteEmbedSettings(input);

  // An enabled embed with no listed origin is allow-none: it would reject every
  // site and silently never load. `*` counts as the allow-all origin entry.
  if (normalized.websiteEmbedEnabled && normalized.websiteEmbedAllowedOrigins.length === 0) {
    throw new Error(
      'At least one allowed origin is required when website embed is enabled (use "*" to allow all)',
    );
  }

  return normalized;
};

// Read path: tolerate any previously-persisted state. Legacy rows can carry
// websiteEmbedEnabled=true with no stored origins (e.g. left behind when 081 moved
// the origin allow-list onto per-agent access grants). Reads must never throw on
// stored data, so coercion degrades that contradictory state to allow-none (disabled)
// — the same runtime effect an enabled-but-originless embed already has — instead of
// enforcing the write-time invariant.
export const coerceWebsiteEmbedSettings = (
  input: WebsiteEmbedSettingsInput,
): WebsiteEmbedSettingsRecord => {
  const normalized = normalizeWebsiteEmbedSettings(input);

  if (normalized.websiteEmbedEnabled && normalized.websiteEmbedAllowedOrigins.length === 0) {
    return { ...normalized, websiteEmbedEnabled: false };
  }

  return normalized;
};
