import { badRequest } from "../../shared/domain/errors.js";
import { normalizeLocaleTag } from "../settings/contracts/assistantBootstrap.js";

export const agentConversationModes = ["factual", "guided", "exploratory"] as const;
export type AgentConversationMode = (typeof agentConversationModes)[number];

export const agentSurfacePositions = ["bottom-right", "bottom-left"] as const;
export type AgentSurfacePosition = (typeof agentSurfacePositions)[number];

const DEFAULT_SUGGESTED_QUESTIONS_ENABLED = true;
const DEFAULT_AGENT_SURFACE_POSITION: AgentSurfacePosition = "bottom-right";

export interface AgentBehaviorSettings {
  customInstruction: string;
  suggestedQuestionsEnabled: boolean;
  retrievalEnabled: boolean;
  logo: AgentLogo | null;
  theme: AgentEmbedTheme;
}

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

export interface AgentEmbedTheme {
  brand: string;
  brandText: string;
  surface: string;
  text: string;
}

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

export interface ConversationAgentSurfaceSettings {
  authenticatedChat: AuthenticatedChatSurfaceSettings;
  anonymousChat: AnonymousChatSurfaceSettings;
  websiteEmbed: WebsiteEmbedSurfaceSettings;
}

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationAgent extends Agent, AgentBehaviorSettings, AgentGreetingSettings {
  surfaceSettings: ConversationAgentSurfaceSettings;
}

export type AgentRecord = ConversationAgent;

export type AgentSurfaceSettingsInput = {
  authenticatedChat?: Partial<AuthenticatedChatSurfaceSettings>;
  anonymousChat?: Partial<AnonymousChatSurfaceSettings>;
  websiteEmbed?: Partial<WebsiteEmbedSurfaceSettings>;
};

export type AgentInput = Partial<
  Pick<
    ConversationAgent,
    | "name"
    | keyof AgentBehaviorSettings
    | keyof AgentGreetingSettings
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

export const defaultAgentEmbedTheme = (): AgentEmbedTheme => ({
  brand: "#0f172a",
  brandText: "#f8fafc",
  surface: "#ffffff",
  text: "#0f172a",
});

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

export const validateAgentInput = (input: AgentInput = {}): NormalizedAgentInput => {
  const websiteEmbedEnabled = Boolean(input.surfaceSettings?.websiteEmbed?.enabled);
  const websiteEmbedAllowedOrigins = normalizeWebsiteEmbedAllowedOrigins(input.surfaceSettings?.websiteEmbed?.allowedOrigins);
  if (websiteEmbedEnabled && websiteEmbedAllowedOrigins.length === 0) {
    throw badRequest("At least one allowed origin is required when website embed is enabled");
  }

  return {
    name: normalizeText(input.name ?? "Agent", "name", 200),
    customInstruction: normalizeLongText(input.customInstruction, "customInstruction", 2000),
    suggestedQuestionsEnabled: input.suggestedQuestionsEnabled ?? DEFAULT_SUGGESTED_QUESTIONS_ENABLED,
    retrievalEnabled: input.retrievalEnabled ?? true,
    logo: normalizeAgentLogo(input.logo),
    theme: normalizeEmbedTheme(input.theme ?? input.surfaceSettings?.websiteEmbed?.theme),
    greetingInstruction: normalizeText(input.greetingInstruction, "greetingInstruction", 200),
    assistantDefaultLocale: normalizeLocaleTag(input.assistantDefaultLocale),
    proactiveGreetingEnabled: Boolean(input.proactiveGreetingEnabled),
    surfaceSettings: {
      authenticatedChat: {
        enabled: input.surfaceSettings?.authenticatedChat?.enabled ?? true,
      },
      anonymousChat: {
        enabled: Boolean(input.surfaceSettings?.anonymousChat?.enabled),
        token: input.surfaceSettings?.anonymousChat?.token ?? null,
      },
      websiteEmbed: {
        enabled: websiteEmbedEnabled,
        token: input.surfaceSettings?.websiteEmbed?.token ?? null,
        allowedOrigins: websiteEmbedAllowedOrigins,
        launcherLabel: normalizeText(input.surfaceSettings?.websiteEmbed?.launcherLabel ?? "Chat with us", "websiteEmbedLauncherLabel", 80),
        launcherPosition: normalizeSurfacePosition(input.surfaceSettings?.websiteEmbed?.launcherPosition),
        theme: normalizeEmbedTheme(input.surfaceSettings?.websiteEmbed?.theme ?? input.theme),
        copy: normalizeEmbedCopy(input.surfaceSettings?.websiteEmbed?.copy),
        expertOverrides: normalizeEmbedExpertOverrides(input.surfaceSettings?.websiteEmbed?.expertOverrides),
      },
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
});

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
