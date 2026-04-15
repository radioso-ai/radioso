export const websiteEmbedLauncherIcons = ["chat", "sparkles", "message"] as const;
export const websiteEmbedLauncherPositions = ["bottom-right", "bottom-left"] as const;

export type WebsiteEmbedLauncherIcon = (typeof websiteEmbedLauncherIcons)[number];
export type WebsiteEmbedLauncherPosition = (typeof websiteEmbedLauncherPositions)[number];

export interface WebsiteEmbedSettingsRecord {
  websiteEmbedEnabled: boolean;
  websiteEmbedToken: string | null;
  websiteEmbedAllowedOrigins: string[];
  websiteEmbedLauncherLabel: string;
  websiteEmbedLauncherIcon: WebsiteEmbedLauncherIcon;
  websiteEmbedLauncherPosition: WebsiteEmbedLauncherPosition;
}

export interface WebsiteEmbedSettingsInput {
  websiteEmbedEnabled?: boolean;
  websiteEmbedToken?: string | null;
  websiteEmbedAllowedOrigins?: string[];
  websiteEmbedLauncherLabel?: string;
  websiteEmbedLauncherIcon?: WebsiteEmbedLauncherIcon;
  websiteEmbedLauncherPosition?: WebsiteEmbedLauncherPosition;
}

export const DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL = "Chat with us";
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_ICON: WebsiteEmbedLauncherIcon = "chat";
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION: WebsiteEmbedLauncherPosition = "bottom-right";
export const DEFAULT_WEBSITE_EMBED_SCRIPT_PATH = "/radioso-embed.js";

export const defaultWebsiteEmbedSettings = (): WebsiteEmbedSettingsRecord => ({
  websiteEmbedEnabled: false,
  websiteEmbedToken: null,
  websiteEmbedAllowedOrigins: [],
  websiteEmbedLauncherLabel: DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL,
  websiteEmbedLauncherIcon: DEFAULT_WEBSITE_EMBED_LAUNCHER_ICON,
  websiteEmbedLauncherPosition: DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION,
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
    websiteEmbedLauncherLabel:
      input.websiteEmbedLauncherLabel?.trim().replace(/\s+/g, " ") || defaults.websiteEmbedLauncherLabel,
    websiteEmbedLauncherIcon: input.websiteEmbedLauncherIcon ?? defaults.websiteEmbedLauncherIcon,
    websiteEmbedLauncherPosition: input.websiteEmbedLauncherPosition ?? defaults.websiteEmbedLauncherPosition,
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

