import type {
  AgentLogo,
  AgentSourceScope,
  ConversationAgent,
  ConversationAgentSurfaceSettings,
  WebsiteEmbedSurfaceSettings,
} from "./domain.js";
import type {
  AuthoredDirective,
  AuthoredDirectiveCondition,
  AuthoredDirectiveCriticality,
} from "./authoredDirectives.js";
import type { ChatTurnRoute } from "../../shared/domain/chatTurnRoute.js";

export const AGENT_CONFIG_SCHEMA_VERSION = 1;

export type AgentConfigPortability = "portable" | "ref" | "secret";

export type AgentConfigRefKind =
  | "documentSource"
  | "storageBucket"
  | "storageObjectPath"
  | "storageGeneration"
  | "websiteEmbedAllowedOrigin";

export interface AgentConfigSecretPlaceholder {
  __redacted: "secret";
}

export interface AgentConfigRefPlaceholder {
  __ref: AgentConfigRefKind;
}

export interface AgentLogoConfig {
  bucket: AgentConfigRefPlaceholder;
  objectPath: AgentConfigRefPlaceholder;
  generation: AgentConfigRefPlaceholder | null;
  mimeType: string;
  filename: string;
  sizeBytes: number;
}

export type AgentSourceScopeConfig =
  | { mode: "all" }
  | { mode: "selected"; sourceIds: AgentConfigRefPlaceholder[] };

export interface WebsiteEmbedSurfaceConfig extends Omit<WebsiteEmbedSurfaceSettings, "token" | "allowedOrigins"> {
  token: AgentConfigSecretPlaceholder | null;
  allowedOrigins: AgentConfigRefPlaceholder[];
}

export interface AgentSurfaceConfig extends Omit<ConversationAgentSurfaceSettings, "anonymousChat" | "websiteEmbed" | "extensions"> {
  anonymousChat: {
    enabled: boolean;
    token: AgentConfigSecretPlaceholder | null;
  };
  websiteEmbed: WebsiteEmbedSurfaceConfig;
  extensions: Record<string, unknown>;
}

export interface AuthoredDirectiveConfig {
  name: string;
  condition: AuthoredDirectiveCondition;
  action: string;
  priority: number | null;
  criticality: AuthoredDirectiveCriticality | null;
  requiredCapabilities: string[];
  dependsOn: string[];
  excludes: string[];
  routes: ChatTurnRoute[];
  description: string | null;
  metadata: Record<string, unknown>;
}

export interface AgentConfig {
  schemaVersion: typeof AGENT_CONFIG_SCHEMA_VERSION;
  portability: Record<string, AgentConfigPortability>;
  name: string;
  customInstruction: string;
  suggestedQuestionsEnabled: boolean;
  assistantLinkUtmEnabled: boolean;
  citationDisplayEnabled: boolean;
  contactRequestsEnabled: boolean;
  contactRequestDelivery: ConversationAgent["contactRequestDelivery"];
  retrievalEnabled: boolean;
  logo: AgentLogoConfig | null;
  theme: ConversationAgent["theme"];
  branding: ConversationAgent["branding"];
  greetingInstruction: string;
  assistantDefaultLocale: string | null;
  proactiveGreetingEnabled: boolean;
  surfaceSettings: AgentSurfaceConfig;
  skillSettings: Record<string, unknown>;
  sourceScope: AgentSourceScopeConfig;
  chatModelOverride: ConversationAgent["chatModelOverride"];
  authoredDirectives: AuthoredDirectiveConfig[];
}

type AgentConfigFieldName = Exclude<keyof AgentConfig, "schemaVersion" | "portability">;

interface AgentConfigFieldDescriptor<FieldName extends AgentConfigFieldName> {
  portability: AgentConfigPortability;
  nestedPortability?: readonly [path: string, portability: AgentConfigPortability][];
  serialize: (agent: ConversationAgent) => AgentConfig[FieldName];
}

const secretPlaceholder = (): AgentConfigSecretPlaceholder => ({ __redacted: "secret" });

const refPlaceholder = (kind: AgentConfigRefKind): AgentConfigRefPlaceholder => ({ __ref: kind });

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const serializeLogo = (logo: AgentLogo | null): AgentLogoConfig | null => {
  if (!logo) {
    return null;
  }
  return {
    bucket: refPlaceholder("storageBucket"),
    objectPath: refPlaceholder("storageObjectPath"),
    generation: logo.generation ? refPlaceholder("storageGeneration") : null,
    mimeType: logo.mimeType,
    filename: logo.filename,
    sizeBytes: logo.sizeBytes,
  };
};

const serializeSourceScope = (sourceScope: AgentSourceScope): AgentSourceScopeConfig => {
  if (sourceScope.mode === "all") {
    return { mode: "all" };
  }
  return {
    mode: "selected",
    sourceIds: sourceScope.sourceIds.map(() => refPlaceholder("documentSource")),
  };
};

const serializeWebsiteEmbed = (websiteEmbed: WebsiteEmbedSurfaceSettings): WebsiteEmbedSurfaceConfig => ({
  enabled: websiteEmbed.enabled,
  token: websiteEmbed.token ? secretPlaceholder() : null,
  allowedOrigins: websiteEmbed.allowedOrigins.map(() => refPlaceholder("websiteEmbedAllowedOrigin")),
  launcherLabel: websiteEmbed.launcherLabel,
  launcherPosition: websiteEmbed.launcherPosition,
  theme: cloneJson(websiteEmbed.theme),
  copy: cloneJson(websiteEmbed.copy),
  expertOverrides: cloneJson(websiteEmbed.expertOverrides),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const serializeSurfaceExtensions = (extensions: Record<string, unknown>): Record<string, unknown> => {
  const next = cloneJson(extensions);
  const websiteEmbed = next.websiteEmbed;
  if (isRecord(websiteEmbed)) {
    const sanitized = { ...websiteEmbed };
    if (typeof sanitized.token === "string" && sanitized.token.length > 0) {
      sanitized.token = secretPlaceholder();
    }
    if (Array.isArray(sanitized.allowedOrigins)) {
      sanitized.allowedOrigins = sanitized.allowedOrigins.map(() => refPlaceholder("websiteEmbedAllowedOrigin"));
    }
    next.websiteEmbed = sanitized;
  }
  return next;
};

const serializeSurfaceSettings = (surfaceSettings: ConversationAgentSurfaceSettings): AgentSurfaceConfig => ({
  authenticatedChat: cloneJson(surfaceSettings.authenticatedChat),
  anonymousChat: {
    enabled: surfaceSettings.anonymousChat.enabled,
    token: surfaceSettings.anonymousChat.token ? secretPlaceholder() : null,
  },
  websiteEmbed: serializeWebsiteEmbed(surfaceSettings.websiteEmbed),
  extensions: serializeSurfaceExtensions(surfaceSettings.extensions),
});

const serializeAuthoredDirectives = (
  authoredDirectives: readonly AuthoredDirective[] | undefined,
): AuthoredDirectiveConfig[] =>
  (authoredDirectives ?? []).map((directive) => ({
    name: directive.name,
    condition: cloneJson(directive.condition),
    action: directive.action,
    priority: directive.priority,
    criticality: directive.criticality,
    requiredCapabilities: [...directive.requiredCapabilities],
    dependsOn: [...directive.dependsOn],
    excludes: [...directive.excludes],
    routes: [...directive.routes],
    description: directive.description,
    metadata: cloneJson(directive.metadata),
  }));

const descriptor = <FieldName extends AgentConfigFieldName>(
  field: AgentConfigFieldDescriptor<FieldName>,
): AgentConfigFieldDescriptor<FieldName> => field;

// Ref and secret placeholders are the export-ready representation for
// workspace-bound values: `{ __redacted: "secret" }` for tokens and
// `{ __ref: "<kind>" }` for references that future import code must remap.
export const AGENT_CONFIG_FIELD_DESCRIPTORS = {
  name: descriptor({
    portability: "portable",
    serialize: (agent) => agent.name,
  }),
  customInstruction: descriptor({
    portability: "portable",
    serialize: (agent) => agent.customInstruction,
  }),
  suggestedQuestionsEnabled: descriptor({
    portability: "portable",
    serialize: (agent) => agent.suggestedQuestionsEnabled,
  }),
  assistantLinkUtmEnabled: descriptor({
    portability: "portable",
    serialize: (agent) => agent.assistantLinkUtmEnabled,
  }),
  citationDisplayEnabled: descriptor({
    portability: "portable",
    serialize: (agent) => agent.citationDisplayEnabled,
  }),
  contactRequestsEnabled: descriptor({
    portability: "portable",
    serialize: (agent) => agent.contactRequestsEnabled,
  }),
  contactRequestDelivery: descriptor({
    portability: "portable",
    serialize: (agent) => cloneJson(agent.contactRequestDelivery),
  }),
  retrievalEnabled: descriptor({
    portability: "portable",
    serialize: (agent) => agent.retrievalEnabled,
  }),
  logo: descriptor({
    portability: "portable",
    nestedPortability: [
      ["logo.bucket", "ref"],
      ["logo.objectPath", "ref"],
      ["logo.generation", "ref"],
    ],
    serialize: (agent) => serializeLogo(agent.logo),
  }),
  theme: descriptor({
    portability: "portable",
    serialize: (agent) => cloneJson(agent.theme),
  }),
  branding: descriptor({
    portability: "portable",
    serialize: (agent) => cloneJson(agent.branding),
  }),
  greetingInstruction: descriptor({
    portability: "portable",
    serialize: (agent) => agent.greetingInstruction,
  }),
  assistantDefaultLocale: descriptor({
    portability: "portable",
    serialize: (agent) => agent.assistantDefaultLocale,
  }),
  proactiveGreetingEnabled: descriptor({
    portability: "portable",
    serialize: (agent) => agent.proactiveGreetingEnabled,
  }),
  surfaceSettings: descriptor({
    portability: "portable",
    nestedPortability: [
      ["surfaceSettings.anonymousChat.token", "secret"],
      ["surfaceSettings.websiteEmbed.token", "secret"],
      ["surfaceSettings.websiteEmbed.allowedOrigins", "ref"],
      ["surfaceSettings.extensions.websiteEmbed.token", "secret"],
      ["surfaceSettings.extensions.websiteEmbed.allowedOrigins", "ref"],
    ],
    serialize: (agent) => serializeSurfaceSettings(agent.surfaceSettings),
  }),
  skillSettings: descriptor({
    portability: "portable",
    serialize: (agent) => cloneJson(agent.skillSettings),
  }),
  sourceScope: descriptor({
    portability: "portable",
    nestedPortability: [["sourceScope.sourceIds", "ref"]],
    serialize: (agent) => serializeSourceScope(agent.sourceScope),
  }),
  chatModelOverride: descriptor({
    portability: "portable",
    serialize: (agent) => cloneJson(agent.chatModelOverride),
  }),
  authoredDirectives: descriptor({
    portability: "portable",
    serialize: (agent) => serializeAuthoredDirectives(agent.authoredDirectives),
  }),
} satisfies {
  [FieldName in AgentConfigFieldName]: AgentConfigFieldDescriptor<FieldName>;
};

const buildPortabilityMap = (): Record<string, AgentConfigPortability> => {
  const portability: Record<string, AgentConfigPortability> = {};
  for (const [fieldName, field] of Object.entries(AGENT_CONFIG_FIELD_DESCRIPTORS)) {
    portability[fieldName] = field.portability;
    for (const [path, classification] of field.nestedPortability ?? []) {
      portability[path] = classification;
    }
  }
  return portability;
};

export const serializeAgentConfig = (agent: ConversationAgent): AgentConfig => {
  const config: Partial<AgentConfig> = {
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
    portability: buildPortabilityMap(),
  };

  for (const [fieldName, field] of Object.entries(AGENT_CONFIG_FIELD_DESCRIPTORS)) {
    config[fieldName as AgentConfigFieldName] = field.serialize(agent) as never;
  }

  return config as AgentConfig;
};
