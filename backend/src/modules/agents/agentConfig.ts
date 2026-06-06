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
} from "./authoredDirectives.js";
import type { ChatTurnRoute } from "../../shared/domain/chatTurnRoute.js";

export const AGENT_CONFIG_SCHEMA_VERSION = 2;

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
  requiredCapabilities: string[];
  dependsOn: string[];
  excludes: string[];
  routes: ChatTurnRoute[];
  description: string | null;
  metadata: Record<string, unknown>;
}

export type InternalAgentLogoConfig = AgentLogo;

export type InternalAgentSourceScopeConfig = AgentSourceScope;

export type InternalWebsiteEmbedSurfaceConfig = WebsiteEmbedSurfaceSettings;

export type InternalAgentSurfaceConfig = ConversationAgentSurfaceSettings;

export interface AgentSkillEnvelope<Settings> {
  enabled: boolean;
  settings: Settings;
}

interface AgentRetrievalDefaultsConfig {
  sourceScope: AgentSourceScopeConfig;
  suggestedQuestionsEnabled: boolean;
  citationDisplayEnabled: boolean;
  assistantLinkUtmEnabled: boolean;
}

interface RetrievalAnswerSkillSettingsConfig extends Record<string, unknown> {
  __agentRetrievalDefaults: AgentRetrievalDefaultsConfig;
}

interface AgentSkillSettingsConfig extends Record<string, unknown> {
  "retrieval.answer": AgentSkillEnvelope<RetrievalAnswerSkillSettingsConfig>;
}

interface InternalAgentSkillSettingsConfig extends Record<string, unknown> {
  "retrieval.answer": AgentSkillEnvelope<InternalRetrievalAnswerSkillSettingsConfig>;
}

interface InternalAgentRetrievalDefaultsConfig {
  sourceScope: InternalAgentSourceScopeConfig;
  suggestedQuestionsEnabled: boolean;
  citationDisplayEnabled: boolean;
  assistantLinkUtmEnabled: boolean;
}

interface InternalRetrievalAnswerSkillSettingsConfig extends Record<string, unknown> {
  __agentRetrievalDefaults: InternalAgentRetrievalDefaultsConfig;
}

export interface AgentConfig {
  schemaVersion: typeof AGENT_CONFIG_SCHEMA_VERSION;
  portability: Record<string, AgentConfigPortability>;
  name: string;
  customInstruction: string;
  contactRequestsEnabled: boolean;
  contactRequestDelivery: ConversationAgent["contactRequestDelivery"];
  logo: AgentLogoConfig | null;
  theme: ConversationAgent["theme"];
  branding: ConversationAgent["branding"];
  greetingInstruction: string;
  assistantDefaultLocale: string | null;
  proactiveGreetingEnabled: boolean;
  surfaceSettings: AgentSurfaceConfig;
  skillSettings: AgentSkillSettingsConfig;
  chatModelOverride: ConversationAgent["chatModelOverride"];
  authoredDirectives: AuthoredDirectiveConfig[];
}

type InternalAgentConfigValueField =
  | "logo"
  | "surfaceSettings"
  | "skillSettings";

export interface InternalAgentConfig extends Omit<AgentConfig, InternalAgentConfigValueField> {
  logo: InternalAgentLogoConfig | null;
  surfaceSettings: InternalAgentSurfaceConfig;
  skillSettings: InternalAgentSkillSettingsConfig;
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

const RETRIEVAL_ANSWER_SKILL_KEY = "retrieval.answer";
const AGENT_RETRIEVAL_DEFAULTS_KEY = "__agentRetrievalDefaults";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

const cloneRetrievalAnswerTuning = (agent: ConversationAgent): Record<string, unknown> => {
  const existingSettings = agent.skillSettings[RETRIEVAL_ANSWER_SKILL_KEY];
  return isRecord(existingSettings) ? cloneJson(existingSettings) : {};
};

const projectSkillSettings = (agent: ConversationAgent, sourceScope: AgentSourceScopeConfig): AgentSkillSettingsConfig => {
  const settings: RetrievalAnswerSkillSettingsConfig = {
    ...cloneRetrievalAnswerTuning(agent),
    [AGENT_RETRIEVAL_DEFAULTS_KEY]: {
      sourceScope,
      suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
      citationDisplayEnabled: agent.citationDisplayEnabled,
      assistantLinkUtmEnabled: agent.assistantLinkUtmEnabled,
    },
  };
  return {
    ...cloneJson(agent.skillSettings),
    [RETRIEVAL_ANSWER_SKILL_KEY]: {
      enabled: agent.retrievalEnabled,
      settings,
    },
  };
};

const projectInternalSkillSettings = (
  agent: ConversationAgent,
  sourceScope: InternalAgentSourceScopeConfig,
): InternalAgentSkillSettingsConfig => {
  const settings: InternalRetrievalAnswerSkillSettingsConfig = {
    ...cloneRetrievalAnswerTuning(agent),
    [AGENT_RETRIEVAL_DEFAULTS_KEY]: {
      sourceScope,
      suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
      citationDisplayEnabled: agent.citationDisplayEnabled,
      assistantLinkUtmEnabled: agent.assistantLinkUtmEnabled,
    },
  };
  return {
    ...cloneJson(agent.skillSettings),
    [RETRIEVAL_ANSWER_SKILL_KEY]: {
      enabled: agent.retrievalEnabled,
      settings,
    },
  };
};

const isSkillEnvelope = (value: unknown): value is AgentSkillEnvelope<Record<string, unknown>> =>
  isRecord(value) && typeof value.enabled === "boolean" && isRecord(value.settings);

const isInternalSourceScope = (value: unknown): value is InternalAgentSourceScopeConfig => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.mode === "all") {
    return true;
  }
  return value.mode === "selected" && Array.isArray(value.sourceIds)
    && value.sourceIds.every((sourceId) => typeof sourceId === "string");
};

const optionalBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const isInternalRetrievalDefaults = (value: unknown): value is InternalAgentRetrievalDefaultsConfig =>
  isRecord(value);

const splitRetrievalAnswerEnvelope = (skillSettings: InternalAgentSkillSettingsConfig): {
  retrievalEnabled: boolean;
  sourceScope: InternalAgentSourceScopeConfig;
  suggestedQuestionsEnabled: boolean;
  citationDisplayEnabled: boolean;
  assistantLinkUtmEnabled: boolean;
  skillSettings: Record<string, unknown>;
} => {
  const nextSkillSettings: Record<string, unknown> = cloneJson(skillSettings);
  const envelope = nextSkillSettings[RETRIEVAL_ANSWER_SKILL_KEY];
  if (!isSkillEnvelope(envelope)) {
    return {
      retrievalEnabled: true,
      sourceScope: { mode: "all" },
      suggestedQuestionsEnabled: true,
      citationDisplayEnabled: true,
      assistantLinkUtmEnabled: true,
      skillSettings: nextSkillSettings,
    };
  }

  const defaults = envelope.settings[AGENT_RETRIEVAL_DEFAULTS_KEY];
  const remainingSettings = cloneJson(envelope.settings);
  delete remainingSettings[AGENT_RETRIEVAL_DEFAULTS_KEY];
  const remainingKeys = Object.keys(remainingSettings);
  if (remainingKeys.length > 0) {
    nextSkillSettings[RETRIEVAL_ANSWER_SKILL_KEY] = remainingSettings;
  } else {
    delete nextSkillSettings[RETRIEVAL_ANSWER_SKILL_KEY];
  }

  return {
    retrievalEnabled: envelope.enabled,
    sourceScope: isInternalRetrievalDefaults(defaults) && isInternalSourceScope(defaults.sourceScope)
      ? cloneJson(defaults.sourceScope)
      : { mode: "all" },
    suggestedQuestionsEnabled: isInternalRetrievalDefaults(defaults)
      ? optionalBoolean(defaults.suggestedQuestionsEnabled, true)
      : true,
    citationDisplayEnabled: isInternalRetrievalDefaults(defaults)
      ? optionalBoolean(defaults.citationDisplayEnabled, true)
      : true,
    assistantLinkUtmEnabled: isInternalRetrievalDefaults(defaults)
      ? optionalBoolean(defaults.assistantLinkUtmEnabled, true)
      : true,
    skillSettings: nextSkillSettings,
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
  contactRequestsEnabled: descriptor({
    portability: "portable",
    serialize: (agent) => agent.contactRequestsEnabled,
  }),
  contactRequestDelivery: descriptor({
    portability: "portable",
    serialize: (agent) => cloneJson(agent.contactRequestDelivery),
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
    nestedPortability: [["skillSettings[\"retrieval.answer\"].settings.__agentRetrievalDefaults.sourceScope.sourceIds", "ref"]],
    serialize: (agent) => projectSkillSettings(agent, serializeSourceScope(agent.sourceScope)),
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

export const projectInternalAgentConfig = (agent: ConversationAgent): InternalAgentConfig => ({
  schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
  portability: buildPortabilityMap(),
  name: agent.name,
  customInstruction: agent.customInstruction,
  contactRequestsEnabled: agent.contactRequestsEnabled,
  contactRequestDelivery: cloneJson(agent.contactRequestDelivery),
  logo: agent.logo ? cloneJson(agent.logo) : null,
  theme: cloneJson(agent.theme),
  branding: cloneJson(agent.branding),
  greetingInstruction: agent.greetingInstruction,
  assistantDefaultLocale: agent.assistantDefaultLocale,
  proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
  surfaceSettings: cloneJson(agent.surfaceSettings),
  skillSettings: projectInternalSkillSettings(agent, cloneJson(agent.sourceScope)),
  chatModelOverride: agent.chatModelOverride ? cloneJson(agent.chatModelOverride) : null,
  authoredDirectives: serializeAuthoredDirectives(agent.authoredDirectives),
});

const INTERNAL_CONFIG_DATE = new Date(0);

const materializeAuthoredDirectives = (
  directives: readonly AuthoredDirectiveConfig[],
  identity: { agentId: string },
): AuthoredDirective[] =>
  directives.map((directive, index) => ({
    id: `${identity.agentId}:directive:${index}`,
    agentId: identity.agentId,
    name: directive.name,
    condition: cloneJson(directive.condition),
    action: directive.action,
    priority: directive.priority,
    requiredCapabilities: [...directive.requiredCapabilities],
    dependsOn: [...directive.dependsOn],
    excludes: [...directive.excludes],
    routes: [...directive.routes],
    description: directive.description,
    metadata: cloneJson(directive.metadata),
    createdAt: new Date(INTERNAL_CONFIG_DATE.getTime()),
    updatedAt: new Date(INTERNAL_CONFIG_DATE.getTime()),
  }));

export const materializeAgentFromConfig = (
  config: InternalAgentConfig,
  identity: { agentId: string; workspaceId: string },
): ConversationAgent => {
  const retrievalAnswer = splitRetrievalAnswerEnvelope(config.skillSettings);

  return {
    id: identity.agentId,
    workspaceId: identity.workspaceId,
    name: config.name,
    customInstruction: config.customInstruction,
    suggestedQuestionsEnabled: retrievalAnswer.suggestedQuestionsEnabled,
    assistantLinkUtmEnabled: retrievalAnswer.assistantLinkUtmEnabled,
    citationDisplayEnabled: retrievalAnswer.citationDisplayEnabled,
    contactRequestsEnabled: config.contactRequestsEnabled,
    contactRequestDelivery: cloneJson(config.contactRequestDelivery),
    retrievalEnabled: retrievalAnswer.retrievalEnabled,
    logo: config.logo ? cloneJson(config.logo) : null,
    theme: cloneJson(config.theme),
    branding: cloneJson(config.branding),
    greetingInstruction: config.greetingInstruction,
    assistantDefaultLocale: config.assistantDefaultLocale,
    proactiveGreetingEnabled: config.proactiveGreetingEnabled,
    sourceScope: cloneJson(retrievalAnswer.sourceScope),
    surfaceSettings: cloneJson(config.surfaceSettings),
    skillSettings: retrievalAnswer.skillSettings,
    chatModelOverride: config.chatModelOverride ? cloneJson(config.chatModelOverride) : null,
    authoredDirectives: materializeAuthoredDirectives(config.authoredDirectives, identity),
    createdAt: new Date(INTERNAL_CONFIG_DATE.getTime()),
    updatedAt: new Date(INTERNAL_CONFIG_DATE.getTime()),
  };
};
