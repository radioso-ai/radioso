import type {
  AgentLogo,
  AgentSourceScope,
  ConversationAgent,
  ConversationAgentSurfaceSettings,
  WebsiteEmbedSurfaceSettings,
} from "./domain.js";
import type {
  AuthoredDirective,
  AuthoredDirectiveBinding,
  AuthoredDirectiveLifecycle,
  AuthoredDirectiveCondition,
} from "./authoredDirectives.js";
import type { ChatTurnRoute } from "../../shared/domain/chatTurnRoute.js";
import type { RetrieveSkillConfig } from "../retrieval/public.js";
import {
  refPlaceholder,
  secretPlaceholder,
  type AgentConfigPortability,
  type AgentConfigRefKind,
  type AgentConfigRefPlaceholder,
  type AgentConfigSecretPlaceholder,
} from "./agentConfigPlaceholders.js";
import {
  EMPTY_EXTERNAL_SKILLS,
  EXTERNAL_SKILLS_PORTABILITY,
  projectInternalExternalSkills,
  serializeExternalSkills,
  type AgentExternalSkillsConfig,
  type InternalAgentExternalSkillsConfig,
} from "./externalSkillsConfig.js";

export const AGENT_CONFIG_SCHEMA_VERSION = 3;

export type {
  AgentConfigPortability,
  AgentConfigRefKind,
  AgentConfigRefPlaceholder,
  AgentConfigSecretPlaceholder,
} from "./agentConfigPlaceholders.js";

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
  tags: string[];
  description: string | null;
  binding: AuthoredDirectiveBinding;
  lifecycle: AuthoredDirectiveLifecycle;
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
  webhookExportsEnabled: boolean;
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
  externalSkills: AgentExternalSkillsConfig;
}

type InternalAgentConfigValueField =
  | "logo"
  | "surfaceSettings"
  | "skillSettings"
  | "externalSkills";

export interface InternalAgentConfig extends Omit<AgentConfig, InternalAgentConfigValueField> {
  logo: InternalAgentLogoConfig | null;
  surfaceSettings: InternalAgentSurfaceConfig;
  skillSettings: InternalAgentSkillSettingsConfig;
  externalSkills: InternalAgentExternalSkillsConfig;
}

/**
 * Extra non-agent data the serializer pulls in alongside the `ConversationAgent`.
 * External skills and MCP connections are agent-scoped but live in their own
 * tables, so the export caller supplies them here (defaults to empty).
 */
export interface AgentConfigSerializeContext {
  externalSkills?: InternalAgentExternalSkillsConfig;
}

type AgentConfigFieldName = Exclude<keyof AgentConfig, "schemaVersion" | "portability">;

interface AgentConfigFieldDescriptor<FieldName extends AgentConfigFieldName> {
  portability: AgentConfigPortability;
  nestedPortability?: readonly [path: string, portability: AgentConfigPortability][];
  serialize: (agent: ConversationAgent, context: AgentConfigSerializeContext) => AgentConfig[FieldName];
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const RETRIEVAL_ANSWER_SKILL_KEY = "retrieval.answer";
const AGENT_RETRIEVAL_DEFAULTS_KEY = "__agentRetrievalDefaults";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const mergeConfigValue = (baseline: unknown, override: unknown): unknown => {
  if (override === undefined) {
    return cloneJson(baseline);
  }
  if (override === null || Array.isArray(override) || !isRecord(override)) {
    return cloneJson(override);
  }
  if (!isRecord(baseline)) {
    return cloneJson(override);
  }

  const next: Record<string, unknown> = cloneJson(baseline);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    next[key] = mergeConfigValue(next[key], value);
  }
  return next;
};

export function applyAgentConfigOverride(
  baseline: InternalAgentConfig,
  override: Partial<InternalAgentConfig>,
): InternalAgentConfig;
export function applyAgentConfigOverride(
  baseline: AgentConfig,
  override: Partial<AgentConfig>,
): AgentConfig;
export function applyAgentConfigOverride(
  baseline: AgentConfig | InternalAgentConfig,
  override: Partial<AgentConfig> | Partial<InternalAgentConfig>,
): AgentConfig | InternalAgentConfig {
  const next = cloneJson(baseline) as unknown as Record<string, unknown>;
  const overrideRecord = override as Record<string, unknown>;
  for (const fieldName of Object.keys(AGENT_CONFIG_FIELD_DESCRIPTORS) as AgentConfigFieldName[]) {
    if (!(fieldName in overrideRecord) || overrideRecord[fieldName] === undefined) {
      continue;
    }
    next[fieldName] = mergeConfigValue(next[fieldName], overrideRecord[fieldName]);
  }
  next.schemaVersion = baseline.schemaVersion;
  next.portability = cloneJson(baseline.portability);
  return next as unknown as AgentConfig | InternalAgentConfig;
}

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

/** What {@link effectiveRetrieveAnswerSkillSettings} and {@link canonicalRetrieveAnswerSkillConfig}
 * compare: the retrieve default-answer skill's `sourceScope` in its mode-based agent form, plus
 * every other configurable field of `RetrieveSkillConfig` projected onto one flat settings record,
 * keyed by canonical name (`instruction` renamed to `customInstruction`; every other kept field by
 * its own name). */
export interface RetrieveAnswerSkillEffectiveSettings {
  sourceScope: InternalAgentSourceScopeConfig;
  settings: Record<string, unknown>;
}

/**
 * `retrieveSkillConfigSchema`'s `sourceScope` (modules/retrieval) is `"all" | { sourceIds }`, not
 * this file's mode-based `AgentSourceScopeConfig` — parsed structurally rather than by importing
 * that schema, the same way `agentRepository.ts`'s `sourceScopeFromRetrieveConfig` (the live
 * apply path's equivalent conversion) does.
 */
const sourceScopeFromProposedConfig = (sourceScope: unknown): InternalAgentSourceScopeConfig => {
  if (sourceScope === undefined || sourceScope === "all") {
    return { mode: "all" };
  }
  if (isRecord(sourceScope) && Array.isArray(sourceScope.sourceIds) && sourceScope.sourceIds.every((id) => typeof id === "string")) {
    return { mode: "selected", sourceIds: [...sourceScope.sourceIds] as string[] };
  }
  return { mode: "all" };
};

/**
 * Where a single `retrieveSkillConfigSchema` field lands once `materializeAgentFromConfig` has
 * run. {@link canonicalRetrieveAnswerSkillConfig} and {@link effectiveRetrieveAnswerSkillSettings}
 * both project through this one table instead of each hand-deciding a field's placement, so the
 * two cannot drift the way they did for `sourceScope`/`instruction` (fixed once already) and then
 * `suggestedQuestionsEnabled` (the defect this table replaces: it passed through as a flat tuning
 * key on the proposal side while `effectiveRetrieveAnswerSkillSettings` never surfaced it at all,
 * since `splitRetrievalAnswerEnvelope` only ever reads it nested under
 * `settings.__agentRetrievalDefaults` — so no replay override could ever match an ordinary
 * proposal for the default retrieve skill). Typing this `Record<keyof RetrieveSkillConfig, ...>`
 * makes a field the schema gains with no entry here a compile error rather than a silent drop;
 * `copilot-proposal-evidence-change-match.test.ts` and this file's
 * "retrieve answer skill config canonicalization" suite additionally assert the *runtime*
 * placement is correct and exhaustive.
 *
 * - `sourceScope`: converted to/from the mode-based `AgentSourceScopeConfig`; compared in its own
 *   slot, never folded into `settings`.
 * - `exposedInputs`: configures the skill invocation, not anything `materializeAgentFromConfig`
 *   reads; dropped on both sides.
 * - `suggestedQuestionsEnabled`: `agentRepository.ts`'s `toDefaultRetrieveSkillConfig` always
 *   writes this field from the *agent's* `suggestedQuestionsEnabled` column, and `mapAgent` always
 *   reads it back into that same column — for the default retrieve-answer skill (the only skill a
 *   replay override can speak to at all), this proposal field means the agent-level default, not a
 *   skill-local tuning value. It therefore round-trips through the same
 *   `settings.__agentRetrievalDefaults` slot as `sourceScope`, not as a flat tuning key.
 * - `instruction`: renamed to `customInstruction`, the flat skill-tuning key materialization reads.
 * - everything else: an ordinary skill-tuning key, flat under its own name on both sides.
 */
type RetrieveAnswerFieldLocation =
  | { readonly kind: "sourceScope" }
  | { readonly kind: "dropped" }
  | { readonly kind: "settings"; readonly canonicalKey: string; readonly nestedUnderAgentDefaults?: true };

const RETRIEVE_ANSWER_SKILL_CONFIG_FIELD_LOCATIONS: {
  readonly [Field in keyof RetrieveSkillConfig]: RetrieveAnswerFieldLocation;
} = {
  sourceScope: { kind: "sourceScope" },
  exposedInputs: { kind: "dropped" },
  instruction: { kind: "settings", canonicalKey: "customInstruction" },
  suggestedQuestionsEnabled: { kind: "settings", canonicalKey: "suggestedQuestionsEnabled", nestedUnderAgentDefaults: true },
  suggestedQuestionsCount: { kind: "settings", canonicalKey: "suggestedQuestionsCount" },
  retrievalStrategy: { kind: "settings", canonicalKey: "retrievalStrategy" },
  vectorTopK: { kind: "settings", canonicalKey: "vectorTopK" },
  rerankEnabled: { kind: "settings", canonicalKey: "rerankEnabled" },
  rerankTopK: { kind: "settings", canonicalKey: "rerankTopK" },
  queryRewriteEnabled: { kind: "settings", canonicalKey: "queryRewriteEnabled" },
  temporalStructuredLookupEnabled: { kind: "settings", canonicalKey: "temporalStructuredLookupEnabled" },
  temporalBoostUpcomingEnabled: { kind: "settings", canonicalKey: "temporalBoostUpcomingEnabled" },
  temporalDeterministicSortEnabled: { kind: "settings", canonicalKey: "temporalDeterministicSortEnabled" },
  semanticRewriteInstructions: { kind: "settings", canonicalKey: "semanticRewriteInstructions" },
  lexicalRewriteInstructions: { kind: "settings", canonicalKey: "lexicalRewriteInstructions" },
  metadataRules: { kind: "settings", canonicalKey: "metadataRules" },
};

/**
 * Canonicalizes a `propose_skill_config` proposal's `config` for the retrieve default-answer
 * skill by projecting each field through {@link RETRIEVE_ANSWER_SKILL_CONFIG_FIELD_LOCATIONS} —
 * the same table {@link effectiveRetrieveAnswerSkillSettings} projects a replay's recorded
 * envelope through — so the two sides are comparable by construction, not by two hand-written
 * mappings kept in agreement by inspection.
 */
export const canonicalRetrieveAnswerSkillConfig = (
  config: Record<string, unknown>,
): RetrieveAnswerSkillEffectiveSettings => {
  const settings: Record<string, unknown> = {};
  let sourceScope: InternalAgentSourceScopeConfig = { mode: "all" };
  for (const [field, location] of Object.entries(RETRIEVE_ANSWER_SKILL_CONFIG_FIELD_LOCATIONS)) {
    if (location.kind === "sourceScope") {
      sourceScope = sourceScopeFromProposedConfig(config[field]);
      continue;
    }
    if (location.kind === "dropped") {
      continue;
    }
    const value = config[field];
    if (value !== undefined) {
      settings[location.canonicalKey] = value;
    }
  }
  return { sourceScope, settings };
};

/**
 * The canonical counterpart of {@link canonicalRetrieveAnswerSkillConfig}: what a replay
 * override's recorded `{ enabled, settings }` envelope for the retrieve default-answer skill
 * actually materializes to. Runs the envelope through the same `splitRetrievalAnswerEnvelope`
 * extraction `materializeAgentFromConfig` uses, then projects the result through
 * {@link RETRIEVE_ANSWER_SKILL_CONFIG_FIELD_LOCATIONS} — never a second hand-written mapping. A
 * `.settings` blob shaped after the proposal's own field names (flat `sourceScope`/`instruction`,
 * or a flat `suggestedQuestionsEnabled` instead of nested under `__agentRetrievalDefaults`) leaves
 * the corresponding canonical field absent, surfacing the mismatch instead of byte-matching a
 * configuration the replay never actually ran. See proposalEvidenceService's `agent_skill`
 * evidence check.
 */
export const effectiveRetrieveAnswerSkillSettings = (
  settings: unknown,
): RetrieveAnswerSkillEffectiveSettings => {
  const settingsRecord = isRecord(settings) ? settings : {};
  const wrapped = {
    [RETRIEVAL_ANSWER_SKILL_KEY]: {
      enabled: true,
      settings: settingsRecord,
    },
  } as InternalAgentSkillSettingsConfig;
  const split = splitRetrievalAnswerEnvelope(wrapped);
  const flatSkillSettings = split.skillSettings[RETRIEVAL_ANSWER_SKILL_KEY];
  const flatSettings = isRecord(flatSkillSettings) ? flatSkillSettings : {};
  // Read the raw nested defaults directly rather than splitRetrievalAnswerEnvelope's own
  // suggestedQuestionsEnabled output, which defaults a missing value to `true` for
  // materialization's purposes (an agent always has *some* effective suggested-questions
  // behavior). A canonical comparison must stay symmetric with the proposal side, which leaves a
  // field absent from `.settings` entirely when the proposal never set it; defaulting it here
  // would manufacture a match, or a mismatch, that no override actually earned.
  const agentDefaultsSource = settingsRecord[AGENT_RETRIEVAL_DEFAULTS_KEY];
  const agentDefaultsSettings = isRecord(agentDefaultsSource) ? agentDefaultsSource : {};

  const result: Record<string, unknown> = {};
  for (const location of Object.values(RETRIEVE_ANSWER_SKILL_CONFIG_FIELD_LOCATIONS)) {
    if (location.kind !== "settings") {
      continue;
    }
    const source = location.nestedUnderAgentDefaults ? agentDefaultsSettings : flatSettings;
    const value = source[location.canonicalKey];
    if (value !== undefined) {
      result[location.canonicalKey] = value;
    }
  }

  return { sourceScope: split.sourceScope, settings: result };
};

/**
 * A replay override's `skillSettings[key]` entry as `applyAgentConfigOverride` actually resolves
 * it at replay time: deep-merged onto the case's captured baseline envelope, field by field —
 * never onto a schema default. An override field the operator's replay never touched (an
 * untouched `enabled`, a `.settings` field such as `sourceScope` it never set) means the replay
 * ran with whatever the captured baseline had, so a caller reconstructing what a cited replay
 * actually measured must merge here first and only then canonicalize the result through
 * {@link effectiveRetrieveAnswerSkillSettings} — canonicalizing the override in isolation cannot
 * tell "the replay left this unchanged" apart from "the replay set this to the schema default",
 * which is exactly the gap that let a proposal's stated `sourceScope: "all"` byte-match a replay
 * that never touched `sourceScope` at all, even when the captured baseline was `selected`.
 * Reuses `mergeConfigValue`, the same field-by-field deep merge {@link applyAgentConfigOverride}
 * performs for every other `InternalAgentConfig` field, rather than a second hand-rolled merge
 * that could drift from what a real replay's materialization does.
 */
export const mergeRetrieveAnswerSkillEnvelope = (
  baseline: { enabled: unknown; settings: Record<string, unknown> },
  override: { enabled?: unknown; settings?: Record<string, unknown> },
): { enabled: unknown; settings: Record<string, unknown> } =>
  mergeConfigValue(baseline, override) as { enabled: unknown; settings: Record<string, unknown> };

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
    tags: [...directive.tags],
    description: directive.description,
    binding: directive.binding,
    lifecycle: directive.lifecycle,
    metadata: cloneJson(directive.metadata),
  }));

/**
 * Pairs each of an agent's authored directives with its stable id and canonical serialized
 * content. Canonical serialization (`serializeAuthoredDirectives`, and every replay override an
 * operator or model can author) never carries a directive's real id, so a caller that must
 * resolve directive identity against something the model cannot author — e.g. a replay asked to
 * exclude a specific directive — reads it from here instead of trusting an override's own claim.
 */
export const serializeAuthoredDirectivesWithIds = (
  agent: Pick<ConversationAgent, "authoredDirectives">,
): ReadonlyArray<{ id: string; config: AuthoredDirectiveConfig }> => {
  const directives = agent.authoredDirectives ?? [];
  const serialized = serializeAuthoredDirectives(directives);
  return directives.map((directive, index) => ({ id: directive.id, config: serialized[index]! }));
};

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
  webhookExportsEnabled: descriptor({
    portability: "portable",
    serialize: (agent) => agent.webhookExportsEnabled,
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
  externalSkills: descriptor({
    portability: "portable",
    nestedPortability: EXTERNAL_SKILLS_PORTABILITY,
    serialize: (_agent, context) =>
      serializeExternalSkills(context.externalSkills ?? EMPTY_EXTERNAL_SKILLS),
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

export const serializeAgentConfig = (
  agent: ConversationAgent,
  context: AgentConfigSerializeContext = {},
): AgentConfig => {
  const config: Partial<AgentConfig> = {
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
    portability: buildPortabilityMap(),
  };

  for (const [fieldName, field] of Object.entries(AGENT_CONFIG_FIELD_DESCRIPTORS)) {
    config[fieldName as AgentConfigFieldName] = field.serialize(agent, context) as never;
  }

  return config as AgentConfig;
};

export const projectInternalAgentConfig = (
  agent: ConversationAgent,
  context: AgentConfigSerializeContext = {},
): InternalAgentConfig => ({
  schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
  portability: buildPortabilityMap(),
  name: agent.name,
  customInstruction: agent.customInstruction,
  contactRequestsEnabled: agent.contactRequestsEnabled,
  webhookExportsEnabled: agent.webhookExportsEnabled,
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
  externalSkills: projectInternalExternalSkills(context.externalSkills ?? EMPTY_EXTERNAL_SKILLS),
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
    priority: directive.priority ?? null,
    requiredCapabilities: [...(directive.requiredCapabilities ?? [])],
    dependsOn: [...(directive.dependsOn ?? [])],
    excludes: [...(directive.excludes ?? [])],
    routes: [...(directive.routes ?? [])],
    tags: [...(directive.tags ?? [])],
    description: directive.description ?? null,
    binding: directive.binding ?? null,
    lifecycle: directive.lifecycle ?? null,
    metadata: cloneJson(directive.metadata ?? {}),
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
    webhookExportsEnabled: config.webhookExportsEnabled,
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
