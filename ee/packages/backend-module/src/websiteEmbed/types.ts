/**
 * Canonical shape for the website-embed surface settings, owned by EE.
 * OSS still mirrors this shape on `agent.surfaceSettings.websiteEmbed` for
 * the duration of the reader migration; once readers move to
 * `agent.surfaceSettings.extensions.websiteEmbed`, OSS drops its copy.
 */

export const websiteEmbedLauncherPositions = ["bottom-right", "bottom-left"] as const;
export type WebsiteEmbedLauncherPosition = (typeof websiteEmbedLauncherPositions)[number];

export interface WebsiteEmbedTheme {
  brand: string;
  brandText: string;
  surface: string;
  text: string;
}

export type WebsiteEmbedCopyPacks = Record<string, Record<string, string>>;
export type WebsiteEmbedExpertOverrides = Record<string, string>;

export interface WebsiteEmbedSurfaceSettings {
  enabled: boolean;
  token: string | null;
  allowedOrigins: string[];
  launcherLabel: string;
  launcherPosition: WebsiteEmbedLauncherPosition;
  theme: WebsiteEmbedTheme;
  copy: WebsiteEmbedCopyPacks;
  expertOverrides: WebsiteEmbedExpertOverrides;
}

export const DEFAULT_LAUNCHER_LABEL = "Chat with us";
export const DEFAULT_LAUNCHER_POSITION: WebsiteEmbedLauncherPosition = "bottom-right";
export const DEFAULT_LAUNCHER_LABEL_MAX_LENGTH = 80;
export const MAX_COPY_LOCALES = 10;
export const MAX_ORIGIN_LENGTH = 200;
export const MAX_ALLOWED_ORIGINS = 100;

export const defaultWebsiteEmbedTheme = (): WebsiteEmbedTheme => ({
  brand: "#0f172a",
  brandText: "#f8fafc",
  surface: "#ffffff",
  text: "#0f172a",
});

export const defaultWebsiteEmbedSurfaceSettings = (): WebsiteEmbedSurfaceSettings => ({
  enabled: false,
  token: null,
  allowedOrigins: [],
  launcherLabel: DEFAULT_LAUNCHER_LABEL,
  launcherPosition: DEFAULT_LAUNCHER_POSITION,
  theme: defaultWebsiteEmbedTheme(),
  copy: {},
  expertOverrides: {},
});
