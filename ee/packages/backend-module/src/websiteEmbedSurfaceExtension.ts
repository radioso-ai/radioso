import type { AgentSurfaceExtension } from "./radiosoModuleTypes.js";

import { resolveCopyForAcceptLanguage } from "./websiteEmbed/localeCopy.js";
import {
  defaultWebsiteEmbedSurfaceSettings,
  type WebsiteEmbedSurfaceSettings,
} from "./websiteEmbed/types.js";
import { normalizeWebsiteEmbedSurfaceSettings } from "./websiteEmbed/normalize.js";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Owns the full website-embed surface settings shape. OSS still mirrors the
 * same type on `agent.surfaceSettings.websiteEmbed` during the reader
 * migration; once OSS readers consume from `surfaceSettings.extensions`,
 * this extension becomes the single source of truth.
 */
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
    // Tolerant read path: legacy/unknown shapes return defaults rather than
    // throwing. Bad fields are silently coerced. The strict path is normalize().
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
