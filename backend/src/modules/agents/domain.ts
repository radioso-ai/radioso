import { badRequest } from "../../shared/domain/errors.js";
import { normalizeLocaleTag } from "../../shared/domain/locale.js";
import {
  defaultWebsiteEmbedTheme,
  type WebsiteEmbedThemeSettings,
} from "../../shared/domain/websiteEmbed.js";
import { isKnownModelForProvider } from "../../shared/infra/llm/knownModels.js";
import type { LlmProviderName } from "../../shared/infra/llm/providerTypes.js";
import type { AgentSurfaceExtensionRegistry } from "./surfaceExtensions.js";

const AGENT_PROVIDER_NAMES: readonly LlmProviderName[] = [
  "openai",
  "openai-compatible",
  "gemini",
  "claude",
];

export interface AgentChatModelOverride {
  provider: LlmProviderName;
  model: string;
}

export interface ValidateAgentInputOptions {
  /**
   * When provided, entries in `surfaceSettings.extensions` are validated by
   * the matching extension's `normalize()` method. Unknown keys pass through
   * unchanged (legacy data won't crash). When omitted, all extension entries
   * pass through opaquely — appropriate for trusted DB reads.
   */
  extensions?: AgentSurfaceExtensionRegistry;
}

export const agentSurfacePositions = ["bottom-right", "bottom-left"] as const;
export type AgentSurfacePosition = (typeof agentSurfacePositions)[number];

const DEFAULT_SUGGESTED_QUESTIONS_ENABLED = true;
const DEFAULT_ASSISTANT_LINK_UTM_ENABLED = true;
const DEFAULT_CITATION_DISPLAY_ENABLED = true;
// Contact requests are opt-in per assistant — off until an operator enables the
// capability in the assistant's Skills settings.
const DEFAULT_CONTACT_REQUESTS_ENABLED = false;
const DEFAULT_AGENT_SURFACE_POSITION: AgentSurfacePosition = "bottom-right";
const MAX_EMBED_COPY_LOCALES = 10;

export interface AgentBrandingSettings {
  hidePoweredBy: boolean;
  privacyPolicyUrl: string | null;
}

export interface AgentBehaviorSettings {
  customInstruction: string;
  suggestedQuestionsEnabled: boolean;
  assistantLinkUtmEnabled: boolean;
  // Whether grounded answers expose their source citations. In public surfaces
  // citations are still rendered non-interactively (sources are never openable
  // there); this flag only governs whether they appear at all.
  citationDisplayEnabled: boolean;
  // Whether this assistant offers the "contact a human" capability: surfaces the
  // public-chat contact button and lets the contact routine activate. Opt-in.
  contactRequestsEnabled: boolean;
  retrievalEnabled: boolean;
  logo: AgentLogo | null;
  theme: AgentEmbedTheme;
  branding: AgentBrandingSettings;
}

export type AgentSourceScope =
  | { mode: "all" }
  | { mode: "selected"; sourceIds: string[] };

export interface AgentGreetingSettings {
  greetingInstruction: string;
  assistantDefaultLocale: string | null;
  proactiveGreetingEnabled: boolean;
}

export interface AgentSurfaceSettings {
  enabled: boolean;
}

export interface PublicAgentSurfaceSettings extends AgentSurfaceSettings {
  token: string | null;
}

export interface AuthenticatedChatSurfaceSettings extends AgentSurfaceSettings {}

export interface AnonymousChatSurfaceSettings extends PublicAgentSurfaceSettings {
}

export type AgentEmbedTheme = WebsiteEmbedThemeSettings;

export type AgentEmbedCopyPacks = Record<string, Record<string, string>>;
export type AgentEmbedExpertOverrides = Record<string, string>;

export interface AgentLogo {
  bucket: string;
  objectPath: string;
  generation?: string | null;
  mimeType: string;
  filename: string;
  sizeBytes: number;
}

export interface WebsiteEmbedSurfaceSettings extends PublicAgentSurfaceSettings {
  allowedOrigins: string[];
  launcherLabel: string;
  launcherPosition: AgentSurfacePosition;
  theme: AgentEmbedTheme;
  copy: AgentEmbedCopyPacks;
  expertOverrides: AgentEmbedExpertOverrides;
}

/**
 * `extensions` is the open-ended slot for surfaces contributed by plugins
 * (see `surfaceExtensions.ts`). Keyed by the plugin's `key`. Stored opaquely
 * at this layer; each plugin owns its own validation and shape.
 */
export interface ConversationAgentSurfaceSettings {
  authenticatedChat: AuthenticatedChatSurfaceSettings;
  anonymousChat: AnonymousChatSurfaceSettings;
  websiteEmbed: WebsiteEmbedSurfaceSettings;
  extensions: Record<string, unknown>;
}

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationAgent extends Agent, AgentBehaviorSettings, AgentGreetingSettings {
  sourceScope: AgentSourceScope;
  surfaceSettings: ConversationAgentSurfaceSettings;
  chatModelOverride: AgentChatModelOverride | null;
}

export type AgentRecord = ConversationAgent;

export type AgentSurfaceSettingsInput = {
  authenticatedChat?: Partial<AuthenticatedChatSurfaceSettings>;
  anonymousChat?: Partial<AnonymousChatSurfaceSettings>;
  websiteEmbed?: Partial<WebsiteEmbedSurfaceSettings>;
  extensions?: Record<string, unknown>;
};

export type AgentInput = Partial<
  Pick<
    ConversationAgent,
    | "name"
    | keyof AgentBehaviorSettings
    | keyof AgentGreetingSettings
    | "sourceScope"
    | "chatModelOverride"
  >
> & {
  surfaceSettings?: AgentSurfaceSettingsInput;
};

export type NormalizedAgentInput = Required<Omit<AgentInput, "surfaceSettings">> & {
  surfaceSettings: ConversationAgentSurfaceSettings;
};

const normalizeText = (value: unknown, fieldName: string, maxLength: number): string => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw badRequest(`${fieldName} must be a string`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > maxLength) {
    throw badRequest(`${fieldName} must not exceed ${maxLength} characters`);
  }
  return normalized;
};

const normalizeLongText = (value: unknown, fieldName: string, maxLength: number): string => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw badRequest(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw badRequest(`${fieldName} must not exceed ${maxLength} characters`);
  }
  return normalized;
};

const normalizeStringArray = (value: unknown, fieldName: string, maxItemLength: number): string[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw badRequest(`${fieldName} must be an array`);
  }
  return [...new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")))]
    .filter(Boolean)
    .map((item) => {
      if (item.length > maxItemLength) {
        throw badRequest(`${fieldName} entries must not exceed ${maxItemLength} characters`);
      }
      return item;
    });
};

const normalizeWebsiteEmbedOrigin = (origin: string): string | null => {
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

const normalizeWebsiteEmbedAllowedOrigins = (value: unknown): string[] =>
  [...new Set(
    normalizeStringArray(value, "websiteEmbedAllowedOrigins", 200)
      .map(normalizeWebsiteEmbedOrigin)
      .filter((origin): origin is string => Boolean(origin)),
  )];

const normalizeSurfacePosition = (value: unknown): AgentSurfacePosition => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_AGENT_SURFACE_POSITION;
  }
  if (agentSurfacePositions.includes(value as AgentSurfacePosition)) {
    return value as AgentSurfacePosition;
  }
  throw badRequest("websiteEmbedLauncherPosition is invalid");
};

export const defaultAgentEmbedTheme = (): AgentEmbedTheme => defaultWebsiteEmbedTheme();

export const defaultAgentBrandingSettings = (): AgentBrandingSettings => ({
  hidePoweredBy: false,
  privacyPolicyUrl: null,
});

const MAX_PRIVACY_POLICY_URL_LENGTH = 2048;

const normalizePrivacyPolicyUrl = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw badRequest("branding.privacyPolicyUrl must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_PRIVACY_POLICY_URL_LENGTH) {
    throw badRequest(`branding.privacyPolicyUrl must not exceed ${MAX_PRIVACY_POLICY_URL_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw badRequest("branding.privacyPolicyUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("branding.privacyPolicyUrl must use http or https");
  }
  return parsed.toString();
};

const normalizeBrandingSettings = (value: unknown): AgentBrandingSettings => {
  const defaults = defaultAgentBrandingSettings();
  if (value === undefined || value === null) {
    return defaults;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("branding must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    hidePoweredBy: typeof record.hidePoweredBy === "boolean" ? record.hidePoweredBy : defaults.hidePoweredBy,
    privacyPolicyUrl: normalizePrivacyPolicyUrl(record.privacyPolicyUrl),
  };
};

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const normalizeEmbedTheme = (value: unknown): AgentEmbedTheme => {
  const defaults = defaultAgentEmbedTheme();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }
  const record = value as Record<string, unknown>;
  const readColor = (key: keyof AgentEmbedTheme) => {
    const candidate = record[key];
    if (candidate === undefined || candidate === null || candidate === "") {
      return defaults[key];
    }
    if (typeof candidate !== "string" || !HEX_COLOR_PATTERN.test(candidate.trim())) {
      throw badRequest(`${key} must be a 6-digit hex color`);
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

const normalizeStringRecord = (
  value: unknown,
  fieldName: string,
  options: { maxKeys: number; maxKeyLength: number; maxValueLength: number },
): Record<string, string> => {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${fieldName} must be an object`);
  }
  const output: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(output).length >= options.maxKeys) {
      throw badRequest(`${fieldName} has too many entries`);
    }
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.length > options.maxKeyLength) {
      throw badRequest(`${fieldName} keys must not exceed ${options.maxKeyLength} characters`);
    }
    if (typeof rawValue !== "string") {
      throw badRequest(`${fieldName}.${normalizedKey} must be a string`);
    }
    const normalizedValue = rawValue.trim();
    if (!normalizedValue) {
      continue;
    }
    if (normalizedValue.length > options.maxValueLength) {
      throw badRequest(`${fieldName}.${normalizedKey} must not exceed ${options.maxValueLength} characters`);
    }
    output[normalizedKey] = normalizedValue;
  }
  return output;
};

const normalizeEmbedCopy = (value: unknown): AgentEmbedCopyPacks => {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("websiteEmbedCopy must be an object");
  }
  const output: AgentEmbedCopyPacks = {};
  for (const [locale, rawPack] of Object.entries(value as Record<string, unknown>)) {
    const normalizedLocale = normalizeLocaleTag(locale);
    if (!normalizedLocale) {
      throw badRequest("websiteEmbedCopy locale keys must be valid locale tags");
    }
    if (!Object.prototype.hasOwnProperty.call(output, normalizedLocale) && Object.keys(output).length >= MAX_EMBED_COPY_LOCALES) {
      throw badRequest(`websiteEmbedCopy must not exceed ${MAX_EMBED_COPY_LOCALES} locales`);
    }
    output[normalizedLocale] = normalizeStringRecord(rawPack, `websiteEmbedCopy.${normalizedLocale}`, {
      maxKeys: 30,
      maxKeyLength: 80,
      maxValueLength: 500,
    });
  }
  return output;
};

const normalizeEmbedExpertOverrides = (value: unknown): AgentEmbedExpertOverrides =>
  normalizeStringRecord(value, "websiteEmbedExpertOverrides", {
    maxKeys: 40,
    maxKeyLength: 80,
    maxValueLength: 500,
  });

const normalizeSurfaceExtensions = (
  value: unknown,
  registry?: AgentSurfaceExtensionRegistry,
): Record<string, unknown> => {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("surfaceSettings.extensions must be an object");
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    const extension = registry?.get(key);
    if (extension) {
      try {
        next[key] = extension.normalize(entry);
      } catch (error) {
        if (error instanceof Error) {
          throw badRequest(error.message);
        }
        throw badRequest(`surfaceSettings.extensions.${key} is invalid`);
      }
    } else {
      // No matching extension registered → pass through. Could be legacy data
      // on read paths, or a write that we don't yet know how to validate.
      next[key] = entry;
    }
  }
  return next;
};

const normalizeAgentLogo = (value: unknown): AgentLogo | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("assistantLogo must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.bucket !== "string" ||
    typeof record.objectPath !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.filename !== "string" ||
    typeof record.sizeBytes !== "number"
  ) {
    throw badRequest("assistantLogo is invalid");
  }
  return {
    bucket: record.bucket,
    objectPath: record.objectPath,
    generation: typeof record.generation === "string" ? record.generation : null,
    mimeType: record.mimeType,
    filename: record.filename,
    sizeBytes: record.sizeBytes,
  };
};

const normalizeSourceScope = (value: unknown): AgentSourceScope => {
  if (value === undefined || value === null) {
    return { mode: "all" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("sourceScope must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "all") {
    return { mode: "all" };
  }
  if (record.mode !== "selected") {
    throw badRequest("sourceScope.mode is invalid");
  }
  if (!Array.isArray(record.sourceIds)) {
    throw badRequest("sourceScope.sourceIds must be an array");
  }
  const sourceIds = [...new Set(record.sourceIds.map((sourceId) => {
    if (typeof sourceId !== "string" || !sourceId.trim()) {
      throw badRequest("sourceScope.sourceIds entries must be strings");
    }
    return sourceId.trim();
  }))];
  if (sourceIds.length > 200) {
    throw badRequest("sourceScope.sourceIds must not exceed 200 entries");
  }
  return {
    mode: "selected",
    sourceIds,
  };
};

const normalizeChatModelOverride = (value: unknown): AgentChatModelOverride | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("chatModelOverride must be an object with provider and model");
  }
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  const model = record.model;
  if (provider === null || provider === undefined || model === null || model === undefined) {
    if (provider === null && model === null) {
      return null;
    }
    if (provider === undefined && model === undefined) {
      return null;
    }
    throw badRequest("chatModelOverride.provider and chatModelOverride.model must be set together");
  }
  if (typeof provider !== "string" || !AGENT_PROVIDER_NAMES.includes(provider as LlmProviderName)) {
    throw badRequest(`Unknown chat provider: ${String(provider)}`);
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    throw badRequest("chatModelOverride.model must not be empty");
  }
  const trimmedModel = model.trim();
  if (!isKnownModelForProvider(provider as LlmProviderName, trimmedModel)) {
    throw badRequest(
      `Model "${trimmedModel}" is not supported for provider "${provider}". See the workspace LLM models settings for the current catalog.`,
    );
  }
  return {
    provider: provider as LlmProviderName,
    model: trimmedModel,
  };
};

export const defaultWebsiteEmbedSurfaceSettings = (): WebsiteEmbedSurfaceSettings => ({
  enabled: false,
  token: null,
  allowedOrigins: [],
  launcherLabel: "Chat with us",
  launcherPosition: DEFAULT_AGENT_SURFACE_POSITION,
  theme: defaultAgentEmbedTheme(),
  copy: {},
  expertOverrides: {},
});

export const normalizeWebsiteEmbedSurfaceSettings = (
  input: unknown,
  options: { themeFallback?: unknown } = {},
): WebsiteEmbedSurfaceSettings => {
  if (input === undefined || input === null) {
    return {
      ...defaultWebsiteEmbedSurfaceSettings(),
      theme: normalizeEmbedTheme(options.themeFallback),
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw badRequest("websiteEmbed surface settings must be an object");
  }
  const record = input as Record<string, unknown>;
  const enabled = Boolean(record.enabled);
  const allowedOrigins = normalizeWebsiteEmbedAllowedOrigins(record.allowedOrigins);
  if (enabled && allowedOrigins.length === 0) {
    throw badRequest("At least one allowed origin is required when website embed is enabled");
  }

  return {
    enabled,
    token: typeof record.token === "string" ? record.token : null,
    allowedOrigins,
    launcherLabel: normalizeText((record.launcherLabel as string | undefined) ?? "Chat with us", "websiteEmbedLauncherLabel", 80),
    launcherPosition: normalizeSurfacePosition(record.launcherPosition),
    theme: normalizeEmbedTheme(record.theme ?? options.themeFallback),
    copy: normalizeEmbedCopy(record.copy),
    expertOverrides: normalizeEmbedExpertOverrides(record.expertOverrides),
  };
};

export const validateAgentInput = (
  input: AgentInput = {},
  options: ValidateAgentInputOptions = {},
): NormalizedAgentInput => {
  const websiteEmbed = normalizeWebsiteEmbedSurfaceSettings(input.surfaceSettings?.websiteEmbed, {
    themeFallback: input.theme,
  });

  // Transitional auto-mirror: the new home for website-embed data is
  // `surfaceSettings.extensions.websiteEmbed`, but the hardcoded
  // `surfaceSettings.websiteEmbed` field still exists for the duration of the
  // reader migration. Always overwrite the mirror from the freshly-normalized
  // hardcoded value so partial patches (e.g. token rotation) keep both views
  // in sync. After step 5 drops the hardcoded field, callers will write to
  // `extensions.websiteEmbed` directly and this auto-mirror goes away.
  const extensions = normalizeSurfaceExtensions(input.surfaceSettings?.extensions, options.extensions);
  extensions.websiteEmbed = websiteEmbed;

  return {
    name: normalizeText(input.name ?? "Agent", "name", 200),
    customInstruction: normalizeLongText(input.customInstruction, "customInstruction", 2000),
    suggestedQuestionsEnabled: input.suggestedQuestionsEnabled ?? DEFAULT_SUGGESTED_QUESTIONS_ENABLED,
    assistantLinkUtmEnabled: input.assistantLinkUtmEnabled ?? DEFAULT_ASSISTANT_LINK_UTM_ENABLED,
    citationDisplayEnabled: input.citationDisplayEnabled ?? DEFAULT_CITATION_DISPLAY_ENABLED,
    contactRequestsEnabled: input.contactRequestsEnabled ?? DEFAULT_CONTACT_REQUESTS_ENABLED,
    retrievalEnabled: input.retrievalEnabled ?? true,
    sourceScope: normalizeSourceScope(input.sourceScope),
    logo: normalizeAgentLogo(input.logo),
    theme: normalizeEmbedTheme(input.theme ?? input.surfaceSettings?.websiteEmbed?.theme),
    branding: normalizeBrandingSettings(input.branding),
    greetingInstruction: normalizeText(input.greetingInstruction, "greetingInstruction", 200),
    assistantDefaultLocale: normalizeLocaleTag(input.assistantDefaultLocale),
    proactiveGreetingEnabled: Boolean(input.proactiveGreetingEnabled),
    chatModelOverride: normalizeChatModelOverride(input.chatModelOverride),
    surfaceSettings: {
      authenticatedChat: {
        enabled: input.surfaceSettings?.authenticatedChat?.enabled ?? true,
      },
      anonymousChat: {
        enabled: Boolean(input.surfaceSettings?.anonymousChat?.enabled),
        token: input.surfaceSettings?.anonymousChat?.token ?? null,
      },
      websiteEmbed,
      extensions,
    },
  };
};

export const mergeAgentSurfaceSettings = (
  current: ConversationAgentSurfaceSettings,
  patch: AgentSurfaceSettingsInput | undefined,
): ConversationAgentSurfaceSettings => ({
  authenticatedChat: {
    ...current.authenticatedChat,
    ...patch?.authenticatedChat,
  },
  anonymousChat: {
    ...current.anonymousChat,
    ...patch?.anonymousChat,
  },
  websiteEmbed: {
    ...current.websiteEmbed,
    ...patch?.websiteEmbed,
  },
  // Per-extension replacement: patch value (when provided) wholly replaces the
  // current value for that key. Extensions own their own deep-merge semantics.
  extensions: {
    ...current.extensions,
    ...(patch?.extensions ?? {}),
  },
});

/**
 * Read the website-embed surface settings from the agent's extensions slot,
 * falling back to the legacy hardcoded field for safety during the reader
 * migration. After step 5 lands and the hardcoded field is removed, this
 * helper falls back to defaults instead.
 */
export const getWebsiteEmbedSurfaceSettings = (
  agent: Pick<ConversationAgent, "surfaceSettings">,
): WebsiteEmbedSurfaceSettings =>
  (agent.surfaceSettings.extensions?.websiteEmbed as WebsiteEmbedSurfaceSettings | undefined)
    ?? agent.surfaceSettings.websiteEmbed;

export const isAgentBootstrapActive = (agent: Pick<AgentRecord, "name" | "proactiveGreetingEnabled">): boolean =>
  agent.proactiveGreetingEnabled && agent.name.trim().length > 0;

export const isAgentRetrievalEnabled = (agent: Pick<AgentRecord, "retrievalEnabled">): boolean =>
  agent.retrievalEnabled;

export const resolveAgentDisplayName = (input: { agentName?: string | null; workspaceName?: string | null }): string => {
  const agentName = input.agentName?.trim();
  if (agentName) {
    return agentName;
  }
  return input.workspaceName?.trim() || "Assistant";
};
