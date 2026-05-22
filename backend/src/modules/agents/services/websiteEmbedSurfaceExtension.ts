import {
  defaultWebsiteEmbedSurfaceSettings,
  normalizeWebsiteEmbedSurfaceSettings,
  type WebsiteEmbedSurfaceSettings,
} from "../domain.js";
import type { AgentSurfaceExtension } from "../surfaceExtensions.js";

import { resolveCopyForAcceptLanguage } from "./websiteEmbed/localeCopy.js";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const createWebsiteEmbedSurfaceExtension = (): AgentSurfaceExtension<WebsiteEmbedSurfaceSettings> => ({
  key: "websiteEmbed",
  defaults() {
    return defaultWebsiteEmbedSurfaceSettings();
  },
  normalize(input) {
    return normalizeWebsiteEmbedSurfaceSettings(input);
  },
  serialize(settings) {
    return settings;
  },
  parse(raw) {
    // Tolerant read path: unknown shapes fall back to defaults rather than
    // throwing. Use normalize() for the strict path.
    if (!isPlainObject(raw)) return defaultWebsiteEmbedSurfaceSettings();
    try {
      return normalizeWebsiteEmbedSurfaceSettings(raw);
    } catch {
      return defaultWebsiteEmbedSurfaceSettings();
    }
  },
  resolveCopyForAcceptLanguage(acceptLanguage) {
    return resolveCopyForAcceptLanguage(acceptLanguage);
  },
});
