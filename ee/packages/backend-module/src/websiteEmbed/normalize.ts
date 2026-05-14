import {
  DEFAULT_LAUNCHER_LABEL,
  DEFAULT_LAUNCHER_LABEL_MAX_LENGTH,
  DEFAULT_LAUNCHER_POSITION,
  MAX_ALLOWED_ORIGINS,
  MAX_COPY_LOCALES,
  MAX_ORIGIN_LENGTH,
  defaultWebsiteEmbedTheme,
  websiteEmbedLauncherPositions,
  type WebsiteEmbedCopyPacks,
  type WebsiteEmbedExpertOverrides,
  type WebsiteEmbedLauncherPosition,
  type WebsiteEmbedSurfaceSettings,
  type WebsiteEmbedTheme,
} from "./types.js";

// Thrown by validators; the OSS-side `normalizeSurfaceExtensions` wrapper
// converts these into `badRequest` HTTP errors before they hit the response.
class ValidationError extends Error {}

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/;
const MAX_LOCALE_LENGTH = 35;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeLabel = (value: unknown): string => {
  if (value === undefined || value === null) {
    return DEFAULT_LAUNCHER_LABEL;
  }
  if (typeof value !== "string") {
    throw new ValidationError("launcherLabel must be a string");
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length > DEFAULT_LAUNCHER_LABEL_MAX_LENGTH) {
    throw new ValidationError(`launcherLabel must not exceed ${DEFAULT_LAUNCHER_LABEL_MAX_LENGTH} characters`);
  }
  return trimmed;
};

const normalizePosition = (value: unknown): WebsiteEmbedLauncherPosition => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LAUNCHER_POSITION;
  }
  if (websiteEmbedLauncherPositions.includes(value as WebsiteEmbedLauncherPosition)) {
    return value as WebsiteEmbedLauncherPosition;
  }
  throw new ValidationError("launcherPosition is invalid");
};

const normalizeOrigin = (origin: string): string | null => {
  const trimmed = origin.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

const normalizeAllowedOrigins = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError("allowedOrigins must be an array");
  }
  if (value.length > MAX_ALLOWED_ORIGINS) {
    throw new ValidationError(`allowedOrigins must not exceed ${MAX_ALLOWED_ORIGINS} entries`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (entry.length > MAX_ORIGIN_LENGTH) {
      throw new ValidationError(`allowedOrigins entries must not exceed ${MAX_ORIGIN_LENGTH} characters`);
    }
    const normalized = normalizeOrigin(entry);
    if (normalized && !out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
};

const normalizeTheme = (value: unknown): WebsiteEmbedTheme => {
  const defaults = defaultWebsiteEmbedTheme();
  if (!isPlainObject(value)) return defaults;
  const readColor = (key: keyof WebsiteEmbedTheme) => {
    const candidate = value[key];
    if (candidate === undefined || candidate === null || candidate === "") {
      return defaults[key];
    }
    if (typeof candidate !== "string" || !HEX_COLOR_PATTERN.test(candidate.trim())) {
      throw new ValidationError(`theme.${key} must be a 6-digit hex color`);
    }
    return candidate.trim();
  };
  return {
    brand: readColor("brand"),
    brandText: readColor("brandText"),
    surface: readColor("surface"),
    text: readColor("text"),
  };
};

const normalizeLocaleTag = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LOCALE_LENGTH) return null;
  if (!LOCALE_PATTERN.test(trimmed)) return null;
  return trimmed;
};

const normalizeStringRecord = (
  value: unknown,
  fieldName: string,
  options: { maxKeys: number; maxKeyLength: number; maxValueLength: number },
): Record<string, string> => {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw new ValidationError(`${fieldName} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (Object.keys(out).length >= options.maxKeys) {
      throw new ValidationError(`${fieldName} has too many entries`);
    }
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.length > options.maxKeyLength) {
      throw new ValidationError(`${fieldName} keys must not exceed ${options.maxKeyLength} characters`);
    }
    if (typeof rawValue !== "string") {
      throw new ValidationError(`${fieldName}.${normalizedKey} must be a string`);
    }
    const normalizedValue = rawValue.trim();
    if (!normalizedValue) continue;
    if (normalizedValue.length > options.maxValueLength) {
      throw new ValidationError(`${fieldName}.${normalizedKey} must not exceed ${options.maxValueLength} characters`);
    }
    out[normalizedKey] = normalizedValue;
  }
  return out;
};

const normalizeCopy = (value: unknown): WebsiteEmbedCopyPacks => {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw new ValidationError("copy must be an object");
  }
  const output: WebsiteEmbedCopyPacks = {};
  for (const [locale, rawPack] of Object.entries(value)) {
    const normalizedLocale = normalizeLocaleTag(locale);
    if (!normalizedLocale) {
      throw new ValidationError("copy locale keys must be valid locale tags");
    }
    if (!Object.prototype.hasOwnProperty.call(output, normalizedLocale) && Object.keys(output).length >= MAX_COPY_LOCALES) {
      throw new ValidationError(`copy must not exceed ${MAX_COPY_LOCALES} locales`);
    }
    output[normalizedLocale] = normalizeStringRecord(rawPack, `copy.${normalizedLocale}`, {
      maxKeys: 30,
      maxKeyLength: 80,
      maxValueLength: 500,
    });
  }
  return output;
};

const normalizeExpertOverrides = (value: unknown): WebsiteEmbedExpertOverrides =>
  normalizeStringRecord(value, "expertOverrides", {
    maxKeys: 40,
    maxKeyLength: 80,
    maxValueLength: 500,
  });

const normalizeToken = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
};

export const normalizeWebsiteEmbedSurfaceSettings = (input: unknown): WebsiteEmbedSurfaceSettings => {
  if (input === undefined || input === null) {
    return {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: DEFAULT_LAUNCHER_LABEL,
      launcherPosition: DEFAULT_LAUNCHER_POSITION,
      theme: defaultWebsiteEmbedTheme(),
      copy: {},
      expertOverrides: {},
    };
  }
  if (!isPlainObject(input)) {
    throw new ValidationError("websiteEmbed surface settings must be an object");
  }

  const enabled = Boolean(input.enabled);
  const allowedOrigins = normalizeAllowedOrigins(input.allowedOrigins);
  if (enabled && allowedOrigins.length === 0) {
    throw new ValidationError("At least one allowed origin is required when website embed is enabled");
  }

  return {
    enabled,
    token: normalizeToken(input.token),
    allowedOrigins,
    launcherLabel: normalizeLabel(input.launcherLabel),
    launcherPosition: normalizePosition(input.launcherPosition),
    theme: normalizeTheme(input.theme),
    copy: normalizeCopy(input.copy),
    expertOverrides: normalizeExpertOverrides(input.expertOverrides),
  };
};
