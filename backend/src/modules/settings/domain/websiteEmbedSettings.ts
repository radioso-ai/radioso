export const websiteEmbedLauncherPositions = ["bottom-right", "bottom-left"] as const;

export type WebsiteEmbedLauncherPosition = (typeof websiteEmbedLauncherPositions)[number];

export interface WebsiteEmbedThemeSettings {
  brand: string;
  brandText: string;
  surface: string;
  text: string;
}

export type WebsiteEmbedCopyPacks = Record<string, Record<string, string>>;
export type WebsiteEmbedExpertOverrides = Record<string, string>;

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

export const DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL = "Chat with us";
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION: WebsiteEmbedLauncherPosition = "bottom-right";
export const DEFAULT_WEBSITE_EMBED_SCRIPT_PATH = "/radioso-embed.js";
export const defaultWebsiteEmbedTheme = (): WebsiteEmbedThemeSettings => ({
  brand: "#0f172a",
  brandText: "#f8fafc",
  surface: "#ffffff",
  text: "#0f172a",
});

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

const normalizeOrigin = (origin: string): string | null => {
  const trimmed = origin.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

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
    .map(normalizeOrigin)
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

export const isAllowedWebsiteEmbedOrigin = (
  allowedOrigins: string[],
  origin: string,
): boolean => {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  return allowedOrigins.includes(normalizedOrigin);
};
