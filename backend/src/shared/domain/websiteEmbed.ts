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

export const DEFAULT_WEBSITE_EMBED_LAUNCHER_LABEL = "Chat with us";
export const DEFAULT_WEBSITE_EMBED_LAUNCHER_POSITION: WebsiteEmbedLauncherPosition = "bottom-right";
export const DEFAULT_WEBSITE_EMBED_SCRIPT_PATH = "/radioso-embed.js";

export const defaultWebsiteEmbedTheme = (): WebsiteEmbedThemeSettings => ({
  brand: "#0f172a",
  brandText: "#f8fafc",
  surface: "#ffffff",
  text: "#0f172a",
});

export const normalizeWebsiteEmbedOrigin = (origin: string): string | null => {
  const trimmed = origin.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

export const isAllowedWebsiteEmbedOrigin = (
  allowedOrigins: string[],
  origin: string,
): boolean => {
  const normalizedOrigin = normalizeWebsiteEmbedOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  // `*` is the allow-all wildcard: any valid request origin is approved. This is
  // the single source of truth for the wildcard so callers never re-encode it.
  if (allowedOrigins.includes("*")) {
    return true;
  }

  return allowedOrigins.includes(normalizedOrigin);
};
