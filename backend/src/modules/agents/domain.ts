import { badRequest } from "../../shared/domain/errors.js";
import { normalizeLocaleTag } from "../settings/contracts/assistantBootstrap.js";

export const agentConversationModes = ["factual", "guided", "exploratory"] as const;
export type AgentConversationMode = (typeof agentConversationModes)[number];

export const agentSurfaceIcons = ["chat", "sparkles", "message"] as const;
export type AgentSurfaceIcon = (typeof agentSurfaceIcons)[number];

export const agentSurfacePositions = ["bottom-right", "bottom-left"] as const;
export type AgentSurfacePosition = (typeof agentSurfacePositions)[number];

const DEFAULT_CONVERSATION_MODE: AgentConversationMode = "guided";
const DEFAULT_SUGGESTED_QUESTIONS_ENABLED = true;
const DEFAULT_SUGGESTED_QUESTIONS_COUNT = 3;
const MIN_SUGGESTED_QUESTIONS_COUNT = 1;
const MAX_SUGGESTED_QUESTIONS_COUNT = 4;
const DEFAULT_AGENT_SURFACE_ICON: AgentSurfaceIcon = "chat";
const DEFAULT_AGENT_SURFACE_POSITION: AgentSurfacePosition = "bottom-right";

export interface AgentBehaviorSettings {
  customInstruction: string;
  conversationMode: AgentConversationMode;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  retrievalEnabled: boolean;
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
  messagesPerMinute: number;
}

export interface WebsiteEmbedSurfaceSettings extends PublicAgentSurfaceSettings {
  allowedOrigins: string[];
  launcherLabel: string;
  icon: AgentSurfaceIcon;
  launcherPosition: AgentSurfacePosition;
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

const normalizeConversationMode = (value: unknown): AgentConversationMode => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_CONVERSATION_MODE;
  }
  if (agentConversationModes.includes(value as AgentConversationMode)) {
    return value as AgentConversationMode;
  }
  throw badRequest("conversationMode is invalid");
};

const normalizeSuggestedQuestionsCount = (value: unknown): number => {
  if (value === undefined || value === null) {
    return DEFAULT_SUGGESTED_QUESTIONS_COUNT;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_SUGGESTED_QUESTIONS_COUNT ||
    value > MAX_SUGGESTED_QUESTIONS_COUNT
  ) {
    throw badRequest("suggestedQuestionsCount is invalid");
  }
  return value;
};

const normalizeMessagesPerMinute = (value: unknown): number => {
  if (value === undefined || value === null) {
    return 10;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 60) {
    throw badRequest("messagesPerMinute must be between 1 and 60");
  }
  return value;
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

const normalizeSurfaceIcon = (value: unknown): AgentSurfaceIcon => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_AGENT_SURFACE_ICON;
  }
  if (agentSurfaceIcons.includes(value as AgentSurfaceIcon)) {
    return value as AgentSurfaceIcon;
  }
  throw badRequest("websiteEmbedLauncherIcon is invalid");
};

const normalizeSurfacePosition = (value: unknown): AgentSurfacePosition => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_AGENT_SURFACE_POSITION;
  }
  if (agentSurfacePositions.includes(value as AgentSurfacePosition)) {
    return value as AgentSurfacePosition;
  }
  throw badRequest("websiteEmbedLauncherPosition is invalid");
};

export const validateAgentInput = (input: AgentInput = {}): NormalizedAgentInput => ({
  name: normalizeText(input.name ?? "Agent", "name", 200),
  customInstruction: normalizeLongText(input.customInstruction, "customInstruction", 2000),
  conversationMode: normalizeConversationMode(input.conversationMode),
  suggestedQuestionsEnabled: input.suggestedQuestionsEnabled ?? DEFAULT_SUGGESTED_QUESTIONS_ENABLED,
  suggestedQuestionsCount: normalizeSuggestedQuestionsCount(input.suggestedQuestionsCount),
  retrievalEnabled: input.retrievalEnabled ?? true,
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
      messagesPerMinute: normalizeMessagesPerMinute(input.surfaceSettings?.anonymousChat?.messagesPerMinute),
    },
    websiteEmbed: {
      enabled: Boolean(input.surfaceSettings?.websiteEmbed?.enabled),
      token: input.surfaceSettings?.websiteEmbed?.token ?? null,
      allowedOrigins: normalizeStringArray(input.surfaceSettings?.websiteEmbed?.allowedOrigins, "websiteEmbedAllowedOrigins", 200),
      launcherLabel: normalizeText(input.surfaceSettings?.websiteEmbed?.launcherLabel ?? "Chat with us", "websiteEmbedLauncherLabel", 80),
      icon: normalizeSurfaceIcon(input.surfaceSettings?.websiteEmbed?.icon),
      launcherPosition: normalizeSurfacePosition(input.surfaceSettings?.websiteEmbed?.launcherPosition),
    },
  },
});

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
