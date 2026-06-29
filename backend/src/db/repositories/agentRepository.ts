import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { RoutineDirectiveScopeOrphan } from "../../modules/routines/public.js";
import { conflict, notFound } from "../../shared/domain/errors.js";
import {
  mergeAgentSurfaceSettings,
  validateAgentInput,
  type AgentBrandingSettings,
  type AgentChatModelOverride,
  type AgentInput,
  type AgentRecord,
  type AgentEmbedCopyPacks,
  type AgentEmbedExpertOverrides,
  type AgentLogo,
  type AgentEmbedTheme,
  type AgentSurfaceExtensionRegistry,
  type AgentSkillSettingsRegistry,
  type AgentSurfacePosition,
  type AgentContactRequestDelivery,
  type NormalizedAgentInput,
  authoredDirectiveInputSchema,
  type AuthoredDirective,
  type AuthoredDirectiveInput,
  type NormalizedAuthoredDirectiveInput,
} from "../../modules/agents/public.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../modules/documents/contracts/index.js";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { LlmProviderName } from "../../shared/infra/llm/providerTypes.js";

interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  retrieval_enabled: boolean;
  source_scope_mode: "all" | "selected";
  source_ids: string[] | null;
  default_retrieve_enabled: boolean | null;
  default_retrieve_config: Record<string, unknown> | null;
  behavior_settings: unknown;
  greeting_settings: unknown;
  output_modes: unknown;
  skill_settings: unknown;
  chat_provider: LlmProviderName | null;
  chat_model: string | null;
  authored_directives: unknown;
  created_at: Date;
  updated_at: Date;
}

interface AgentDirectiveRow {
  id: string;
  agent_id: string;
  name: string;
  condition_kind: "always" | "contextual";
  condition_description: string | null;
  action: string;
  priority: number | null;
  required_capabilities: string[];
  depends_on: string[];
  excludes: string[];
  routes: Array<AuthoredDirective["routes"][number]>;
  scope_tags: string[];
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface LoadedDirectiveJson {
  id?: unknown;
  name?: unknown;
  conditionKind?: unknown;
  conditionDescription?: unknown;
  action?: unknown;
  priority?: unknown;
  requiredCapabilities?: unknown;
  dependsOn?: unknown;
  excludes?: unknown;
  routes?: unknown;
  tags?: unknown;
  description?: unknown;
  metadata?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface DirectiveScopeTagRow {
  id: string;
  scope_tags: string[];
}

export interface RepointRoutineScopeTagsInput {
  agentId: string;
  fromDefinitionId: string;
  toDefinitionId: string;
  survivingStepIds: ReadonlySet<string>;
  transaction?: unknown;
}

export interface RepointRoutineScopeTagsResult {
  repointed: number;
  orphans: RoutineDirectiveScopeOrphan[];
}

const agentDirectiveNameUniqueConstraint = "agent_directives_agent_id_name_key";

const isAgentDirectiveNameUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    table?: unknown;
    detail?: unknown;
  };
  return candidate.code === "23505" && (
    candidate.constraint === agentDirectiveNameUniqueConstraint ||
    (
      candidate.table === "agent_directives" &&
      typeof candidate.detail === "string" &&
      candidate.detail.includes("(agent_id, name)")
    )
  );
};

const directiveNameConflict = (name: string) =>
  conflict(`A directive named "${name}" already exists for this agent.`);

/**
 * The agent projection: the agents row plus two correlated subqueries that aggregate the
 * normalized `agent_document_sources` (manual-source NULL → the sentinel id) and the child
 * `agent_directives` as a JSON array. The aggregation/ordering shape is load-bearing for
 * `mapAgent`, so it stays a single `sql` fragment (the builder can't model the COALESCE'd
 * ARRAY_AGG / json_agg correlated subqueries without more noise than the SQL itself) and is
 * spliced into each agent SELECT. The sentinel id is a trusted constant, never user input.
 */
const agentColumns = sql`
  id,
  workspace_id,
  name,
  retrieval_enabled,
  source_scope_mode,
  COALESCE(
    (
      SELECT ARRAY_AGG(
        COALESCE(source_id::text, ${sql.lit(MANUALLY_ADDED_DOCUMENTS_SOURCE_ID)})
        ORDER BY source_id IS NOT NULL, source_id::text
      )
      FROM agent_document_sources
      WHERE agent_id = agents.id
    ),
    ARRAY[]::text[]
  ) AS source_ids,
  (
    SELECT s.enabled
    FROM agent_skills s
    WHERE s.agent_id = agents.id
      AND s.kind = 'retrieve'
      AND s.invocation_mode = 'default_answer'
    ORDER BY s.created_at ASC
    LIMIT 1
  ) AS default_retrieve_enabled,
  (
    SELECT s.config
    FROM agent_skills s
    WHERE s.agent_id = agents.id
      AND s.kind = 'retrieve'
      AND s.invocation_mode = 'default_answer'
    ORDER BY s.created_at ASC
    LIMIT 1
  ) AS default_retrieve_config,
  behavior_settings,
  greeting_settings,
  output_modes,
  skill_settings,
  chat_provider,
  chat_model,
  COALESCE(
    (
      SELECT json_agg(
        json_build_object(
          'id', agent_directives.id::text,
          'name', agent_directives.name,
          'conditionKind', agent_directives.condition_kind,
          'conditionDescription', agent_directives.condition_description,
          'action', agent_directives.action,
          'priority', agent_directives.priority,
          'requiredCapabilities', agent_directives.required_capabilities,
          'dependsOn', agent_directives.depends_on,
          'excludes', agent_directives.excludes,
          'routes', agent_directives.routes,
          'tags', agent_directives.scope_tags,
          'description', agent_directives.description,
          'metadata', agent_directives.metadata,
          'createdAt', agent_directives.created_at,
          'updatedAt', agent_directives.updated_at
        )
        ORDER BY agent_directives.created_at ASC, agent_directives.id ASC
      )
      FROM agent_directives
      WHERE agent_directives.agent_id = agents.id
    ),
    '[]'::json
  ) AS authored_directives,
  created_at,
  updated_at
`;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const readString = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === "string" ? record[key] : undefined;

const readBoolean = (record: Record<string, unknown>, key: string): boolean | undefined =>
  typeof record[key] === "boolean" ? record[key] : undefined;

const readNumber = (record: Record<string, unknown>, key: string): number | undefined =>
  typeof record[key] === "number" ? record[key] : undefined;

const readStringArray = (record: Record<string, unknown>, key: string): string[] | undefined =>
  Array.isArray(record[key])
    ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string")
    : undefined;

const sourceScopeFromRetrieveConfig = (
  config: Record<string, unknown> | null,
  fallback: { mode: "all" } | { mode: "selected"; sourceIds: string[] },
): { mode: "all" } | { mode: "selected"; sourceIds: string[] } => {
  const sourceScope = config?.sourceScope;
  if (sourceScope === "all") {
    return { mode: "all" };
  }
  if (sourceScope && typeof sourceScope === "object" && !Array.isArray(sourceScope)) {
    const sourceIds = readStringArray(sourceScope as Record<string, unknown>, "sourceIds");
    if (sourceIds) {
      return { mode: "selected", sourceIds };
    }
  }
  return fallback;
};

const skillSettingsFromRetrieveConfig = (
  legacy: Record<string, unknown>,
  config: Record<string, unknown> | null,
): Record<string, unknown> => {
  if (!config) {
    return legacy;
  }
  const { sourceScope: _sourceScope, exposedInputs: _exposedInputs, instruction, ...settings } = config;
  return {
    ...legacy,
    "retrieval.answer": {
      ...asRecord(legacy["retrieval.answer"]),
      ...settings,
      ...(typeof instruction === "string" ? { customInstruction: instruction } : {}),
    },
  };
};

const asMetadata = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const readDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date(String(value));

const mapDirectiveJson = (agentId: string, value: LoadedDirectiveJson): AuthoredDirective | null => {
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.conditionKind !== "always" && value.conditionKind !== "contextual") ||
    typeof value.action !== "string"
  ) {
    return null;
  }
  const condition = value.conditionKind === "contextual"
    ? {
        kind: "contextual" as const,
        description: typeof value.conditionDescription === "string" ? value.conditionDescription : "",
      }
    : { kind: "always" as const };
  return {
    id: value.id,
    agentId,
    name: value.name,
    condition,
    action: value.action,
    priority: typeof value.priority === "number" ? value.priority : null,
    requiredCapabilities: Array.isArray(value.requiredCapabilities)
      ? value.requiredCapabilities.filter((item): item is string => typeof item === "string")
      : [],
    dependsOn: Array.isArray(value.dependsOn)
      ? value.dependsOn.filter((item): item is string => typeof item === "string")
      : [],
    excludes: Array.isArray(value.excludes)
      ? value.excludes.filter((item): item is string => typeof item === "string")
      : [],
    routes: Array.isArray(value.routes)
      ? value.routes.filter((item): item is AuthoredDirective["routes"][number] => typeof item === "string")
      : [],
    tags: Array.isArray(value.tags)
      ? value.tags.filter((item): item is string => typeof item === "string")
      : [],
    description: typeof value.description === "string" ? value.description : null,
    metadata: asMetadata(value.metadata),
    createdAt: readDate(value.createdAt),
    updatedAt: readDate(value.updatedAt),
  };
};

const mapLoadedDirectives = (agentId: string, value: unknown): AuthoredDirective[] =>
  Array.isArray(value)
    ? value
        .map((entry) => mapDirectiveJson(agentId, asRecord(entry) as LoadedDirectiveJson))
        .filter((entry): entry is AuthoredDirective => entry !== null)
    : [];

const mapDirectiveRow = (row: AgentDirectiveRow): AuthoredDirective => ({
  id: row.id,
  agentId: row.agent_id,
  name: row.name,
  condition: row.condition_kind === "contextual"
    ? { kind: "contextual", description: row.condition_description ?? "" }
    : { kind: "always" },
  action: row.action,
  priority: row.priority,
  requiredCapabilities: row.required_capabilities ?? [],
  dependsOn: row.depends_on ?? [],
  excludes: row.excludes ?? [],
  routes: row.routes ?? [],
  tags: row.scope_tags ?? [],
  description: row.description,
  metadata: asMetadata(row.metadata),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const hasOwn = <K extends PropertyKey>(value: object, key: K): value is object & Record<K, unknown> =>
  Object.prototype.hasOwnProperty.call(value, key);

const readContactRequestDelivery = (record: Record<string, unknown>): AgentContactRequestDelivery | undefined =>
  record.contactRequestDelivery && typeof record.contactRequestDelivery === "object" && !Array.isArray(record.contactRequestDelivery)
    ? record.contactRequestDelivery as AgentContactRequestDelivery
    : undefined;

const parseSurfaceExtensions = (
  extensions: Record<string, unknown>,
  registry?: AgentSurfaceExtensionRegistry,
): Record<string, unknown> => {
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extensions)) {
    const extension = registry?.get(key);
    if (!extension) {
      parsed[key] = value;
      continue;
    }

    try {
      parsed[key] = extension.parse(value);
    } catch {
      parsed[key] = extension.defaults();
    }
  }
  return parsed;
};

const toBehaviorSettings = (agent: NormalizedAgentInput): Record<string, unknown> => ({
  customInstruction: agent.customInstruction,
  suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
  assistantLinkUtmEnabled: agent.assistantLinkUtmEnabled,
  citationDisplayEnabled: agent.citationDisplayEnabled,
  contactRequestsEnabled: agent.contactRequestsEnabled,
  webhookExportsEnabled: agent.webhookExportsEnabled,
  handoffOnRetrievalMiss: agent.handoffOnRetrievalMiss,
  contactRequestDelivery: agent.contactRequestDelivery,
  logo: agent.logo,
  theme: agent.theme,
  branding: agent.branding,
});

const toGreetingSettings = (agent: NormalizedAgentInput): Record<string, unknown> => ({
  greetingInstruction: agent.greetingInstruction,
  assistantDefaultLocale: agent.assistantDefaultLocale,
  proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
});

const toOutputModes = (agent: NormalizedAgentInput): Record<string, unknown> => ({
  authenticatedChat: {
    enabled: agent.surfaceSettings.authenticatedChat.enabled,
  },
  anonymousChat: {
    enabled: agent.surfaceSettings.anonymousChat.enabled,
    token: agent.surfaceSettings.anonymousChat.token,
  },
  websiteEmbed: {
    enabled: agent.surfaceSettings.websiteEmbed.enabled,
    token: agent.surfaceSettings.websiteEmbed.token,
    allowedOrigins: agent.surfaceSettings.websiteEmbed.allowedOrigins,
    launcherLabel: agent.surfaceSettings.websiteEmbed.launcherLabel,
    launcherPosition: agent.surfaceSettings.websiteEmbed.launcherPosition,
    theme: agent.surfaceSettings.websiteEmbed.theme,
    copy: agent.surfaceSettings.websiteEmbed.copy,
    expertOverrides: agent.surfaceSettings.websiteEmbed.expertOverrides,
  },
  extensions: agent.surfaceSettings.extensions,
});

const toSkillSettings = (agent: NormalizedAgentInput): Record<string, unknown> => agent.skillSettings;

const toRetrieveSkillSourceScope = (
  sourceScope: NormalizedAgentInput["sourceScope"],
): "all" | { sourceIds: string[] } =>
  sourceScope.mode === "selected"
    ? { sourceIds: sourceScope.sourceIds }
    : "all";

const toDefaultRetrieveSkillConfig = (agent: NormalizedAgentInput): Record<string, unknown> => {
  const retrievalSettings = asRecord(agent.skillSettings["retrieval.answer"]);
  const { customInstruction, similarityThreshold: _similarityThreshold, ...settings } = retrievalSettings;
  return {
    ...settings,
    ...(typeof customInstruction === "string" ? { instruction: customInstruction } : {}),
    sourceScope: toRetrieveSkillSourceScope(agent.sourceScope),
    suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
    exposedInputs: { query: true },
  };
};

const persistableSourceIds = (sourceScope: NormalizedAgentInput["sourceScope"]): Array<string | null> =>
  sourceScope.mode === "selected"
    ? sourceScope.sourceIds.map((sourceId) => sourceId === MANUALLY_ADDED_DOCUMENTS_SOURCE_ID ? null : sourceId)
    : [];

const mapAgent = (
  row: AgentRow,
  surfaceExtensions?: AgentSurfaceExtensionRegistry,
  skillSettings?: AgentSkillSettingsRegistry,
): AgentRecord => {
  const behavior = asRecord(row.behavior_settings);
  const greeting = asRecord(row.greeting_settings);
  const outputModes = asRecord(row.output_modes);
  const authenticatedChat = asRecord(outputModes.authenticatedChat);
  const anonymousChat = asRecord(outputModes.anonymousChat);
  const websiteEmbed = asRecord(outputModes.websiteEmbed);
  const extensions = parseSurfaceExtensions(asRecord(outputModes.extensions), surfaceExtensions);
  const extensionWebsiteEmbed = asRecord(extensions.websiteEmbed);
  const websiteEmbedSource = Object.keys(extensionWebsiteEmbed).length > 0
    ? extensionWebsiteEmbed
    : websiteEmbed;

  const chatOverride: AgentChatModelOverride | null = row.chat_provider && row.chat_model
    ? { provider: row.chat_provider, model: row.chat_model }
    : null;

  const legacySourceScope = row.source_scope_mode === "selected"
    ? { mode: "selected" as const, sourceIds: row.source_ids ?? [] }
    : { mode: "all" as const };
  const retrieveConfig = asRecord(row.default_retrieve_config);
  const hasDefaultRetrieveSkill = row.default_retrieve_enabled !== null || Object.keys(retrieveConfig).length > 0;
  const sourceScope = hasDefaultRetrieveSkill
    ? sourceScopeFromRetrieveConfig(retrieveConfig, legacySourceScope)
    : legacySourceScope;
  const legacySkillSettings = asRecord(row.skill_settings);
  const normalized = validateAgentInput({
    name: row.name,
    customInstruction: readString(behavior, "customInstruction"),
    suggestedQuestionsEnabled: hasDefaultRetrieveSkill
      ? readBoolean(retrieveConfig, "suggestedQuestionsEnabled")
      : readBoolean(behavior, "suggestedQuestionsEnabled"),
    assistantLinkUtmEnabled: readBoolean(behavior, "assistantLinkUtmEnabled") ?? true,
    citationDisplayEnabled: readBoolean(behavior, "citationDisplayEnabled") ?? true,
    contactRequestsEnabled: readBoolean(behavior, "contactRequestsEnabled") ?? false,
    webhookExportsEnabled: readBoolean(behavior, "webhookExportsEnabled") ?? false,
    handoffOnRetrievalMiss: readBoolean(behavior, "handoffOnRetrievalMiss") ?? false,
    contactRequestDelivery: readContactRequestDelivery(behavior),
    retrievalEnabled: hasDefaultRetrieveSkill ? row.default_retrieve_enabled ?? true : row.retrieval_enabled,
    sourceScope,
    skillSettings: skillSettingsFromRetrieveConfig(legacySkillSettings, hasDefaultRetrieveSkill ? retrieveConfig : null),
    logo: (behavior.logo ?? websiteEmbedSource.logo) as AgentLogo | null | undefined,
    theme: (behavior.theme ?? websiteEmbedSource.theme) as AgentEmbedTheme | undefined,
    branding: behavior.branding as AgentBrandingSettings | undefined,
    greetingInstruction: readString(greeting, "greetingInstruction"),
    assistantDefaultLocale: readString(greeting, "assistantDefaultLocale") ?? null,
    proactiveGreetingEnabled: readBoolean(greeting, "proactiveGreetingEnabled"),
    chatModelOverride: chatOverride,
    surfaceSettings: {
      authenticatedChat: {
        enabled: readBoolean(authenticatedChat, "enabled"),
      },
      anonymousChat: {
        enabled: readBoolean(anonymousChat, "enabled"),
        token: readString(anonymousChat, "token") ?? null,
      },
      websiteEmbed: {
        enabled: readBoolean(websiteEmbedSource, "enabled"),
        token: readString(websiteEmbedSource, "token") ?? null,
        allowedOrigins: readStringArray(websiteEmbedSource, "allowedOrigins"),
        launcherLabel: readString(websiteEmbedSource, "launcherLabel"),
        launcherPosition: readString(websiteEmbedSource, "launcherPosition") as AgentSurfacePosition | undefined,
        theme: websiteEmbedSource.theme as AgentEmbedTheme | undefined,
        copy: websiteEmbedSource.copy as AgentEmbedCopyPacks | undefined,
        expertOverrides: websiteEmbedSource.expertOverrides as AgentEmbedExpertOverrides | undefined,
      },
      extensions,
    },
  }, { skillSettings, skillSettingsMode: "read" });

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...normalized,
    authoredDirectives: mapLoadedDirectives(row.id, row.authored_directives),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
};

export interface AgentUpdateOptions {
  expectedUpdatedAt?: Date;
}

export interface AgentRepositoryPort {
  create(workspaceId: string, input: AgentInput): Promise<AgentRecord>;
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null>;
  findDefaultByWorkspaceId(workspaceId: string): Promise<AgentRecord | null>;
  findByAnonymousChatToken(token: string): Promise<AgentRecord | null>;
  findByWebsiteEmbedToken(token: string): Promise<AgentRecord | null>;
  listByWorkspaceId(workspaceId: string): Promise<AgentRecord[]>;
  update(agentId: string, workspaceId: string, input: AgentInput, options?: AgentUpdateOptions): Promise<AgentRecord>;
  listDirectives(agentId: string, workspaceId: string): Promise<AuthoredDirective[]>;
  createDirective(agentId: string, workspaceId: string, input: AuthoredDirectiveInput): Promise<AuthoredDirective>;
  updateDirective(agentId: string, workspaceId: string, directiveId: string, input: Partial<AuthoredDirectiveInput>): Promise<AuthoredDirective>;
  deleteDirective(agentId: string, workspaceId: string, directiveId: string): Promise<boolean>;
  repointRoutineScopeTags?(input: RepointRoutineScopeTagsInput): Promise<RepointRoutineScopeTagsResult>;
  setDefault(workspaceId: string, agentId: string): Promise<void>;
  deleteByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<boolean>;
  countByWorkspaceId(workspaceId: string): Promise<number>;
}

export class AgentRepository implements AgentRepositoryPort {
  constructor(
    private readonly db: Db,
    private readonly surfaceExtensions?: AgentSurfaceExtensionRegistry,
    private readonly skillSettings?: AgentSkillSettingsRegistry,
  ) {}

  async create(workspaceId: string, input: AgentInput): Promise<AgentRecord> {
    const normalized = validateAgentInput(input, {
      extensions: this.surfaceExtensions,
      skillSettings: this.skillSettings,
    });
    return this.db.transaction().execute(async (trx) => {
      const agentId = randomUUID();
      const result = await sql<AgentRow>`
        INSERT INTO agents (
          id,
          workspace_id,
          name,
          retrieval_enabled,
          source_scope_mode,
          behavior_settings,
          greeting_settings,
          output_modes,
          skill_settings,
          chat_provider,
          chat_model
        )
        VALUES (
          ${agentId},
          ${workspaceId},
          ${normalized.name},
          ${normalized.retrievalEnabled},
          ${normalized.sourceScope.mode},
          ${toJsonb(toBehaviorSettings(normalized))},
          ${toJsonb(toGreetingSettings(normalized))},
          ${toJsonb(toOutputModes(normalized))},
          ${toJsonb(toSkillSettings(normalized))},
          ${normalized.chatModelOverride?.provider ?? null},
          ${normalized.chatModelOverride?.model ?? null}
        )
        RETURNING ${agentColumns}
      `.execute(trx);
      await this.replaceSourceScope(trx, agentId, normalized.sourceScope);
      const syncedDefaultRetrieveSkill = await this.syncDefaultRetrieveSkill(trx, agentId, normalized);
      const row = result.rows[0];
      if (!row) {
        throw new Error("Expected created agent");
      }
      return mapAgent({
        ...row,
        source_ids: normalized.sourceScope.mode === "selected" ? normalized.sourceScope.sourceIds : [],
        default_retrieve_enabled: syncedDefaultRetrieveSkill ? normalized.retrievalEnabled : row.default_retrieve_enabled,
        default_retrieve_config: syncedDefaultRetrieveSkill ? toDefaultRetrieveSkillConfig(normalized) : row.default_retrieve_config,
      }, this.surfaceExtensions, this.skillSettings);
    });
  }

  async findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null> {
    const result = await sql<AgentRow>`
      SELECT ${agentColumns} FROM agents WHERE id = ${agentId} AND workspace_id = ${workspaceId}
    `.execute(this.db);
    const row = result.rows[0];
    return row ? mapAgent(row, this.surfaceExtensions, this.skillSettings) : null;
  }

  async findDefaultByWorkspaceId(workspaceId: string): Promise<AgentRecord | null> {
    const result = await sql<AgentRow>`
      SELECT ${agentColumns}
      FROM agents
      WHERE id = (SELECT default_agent_id FROM workspaces WHERE id = ${workspaceId})
        AND workspace_id = ${workspaceId}
    `.execute(this.db);
    const row = result.rows[0];
    return row ? mapAgent(row, this.surfaceExtensions, this.skillSettings) : null;
  }

  async findByAnonymousChatToken(token: string): Promise<AgentRecord | null> {
    const result = await sql<AgentRow>`
      SELECT ${agentColumns}
      FROM agents
      WHERE output_modes #>> '{anonymousChat,token}' = ${token}
    `.execute(this.db);
    const row = result.rows[0];
    return row ? mapAgent(row, this.surfaceExtensions, this.skillSettings) : null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<AgentRecord | null> {
    const result = await sql<AgentRow>`
      SELECT ${agentColumns}
      FROM agents
      WHERE output_modes #>> '{websiteEmbed,token}' = ${token}
    `.execute(this.db);
    const row = result.rows[0];
    return row ? mapAgent(row, this.surfaceExtensions, this.skillSettings) : null;
  }

  async listByWorkspaceId(workspaceId: string): Promise<AgentRecord[]> {
    const result = await sql<AgentRow>`
      SELECT ${agentColumns}
      FROM agents
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at ASC, id ASC
    `.execute(this.db);
    return result.rows.map((row) => mapAgent(row, this.surfaceExtensions, this.skillSettings));
  }

  async update(agentId: string, workspaceId: string, input: AgentInput, options: AgentUpdateOptions = {}): Promise<AgentRecord> {
    const current = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!current) {
      throw new Error(`Agent ${agentId} not found`);
    }
    const { authoredDirectives: _authoredDirectives, ...currentAgentInput } = current;
    const normalized = validateAgentInput(
      {
        ...currentAgentInput,
        ...input,
        surfaceSettings: mergeAgentSurfaceSettings(current.surfaceSettings, input.surfaceSettings),
      },
      { extensions: this.surfaceExtensions, skillSettings: this.skillSettings },
    );
    const expectedUpdatedAt = options.expectedUpdatedAt ?? current.updatedAt;
    return this.db.transaction().execute(async (trx) => {
      const result = await sql<AgentRow>`
        UPDATE agents
        SET name = ${normalized.name},
            retrieval_enabled = ${normalized.retrievalEnabled},
            source_scope_mode = ${normalized.sourceScope.mode},
            behavior_settings = ${toJsonb(toBehaviorSettings(normalized))},
            greeting_settings = ${toJsonb(toGreetingSettings(normalized))},
            output_modes = ${toJsonb(toOutputModes(normalized))},
            skill_settings = ${toJsonb(toSkillSettings(normalized))},
            chat_provider = ${normalized.chatModelOverride?.provider ?? null},
            chat_model = ${normalized.chatModelOverride?.model ?? null},
            updated_at = ${currentTimestamp()}
        WHERE id = ${agentId}
          AND workspace_id = ${workspaceId}
          AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ${expectedUpdatedAt}::timestamptz)
        RETURNING ${agentColumns}
      `.execute(trx);
      const row = result.rows[0];
      if (!row) {
        throw conflict("Agent was updated by another writer; reload before saving again");
      }
      await this.replaceSourceScope(trx, agentId, normalized.sourceScope);
      const syncedDefaultRetrieveSkill = await this.syncDefaultRetrieveSkill(trx, agentId, normalized);
      return mapAgent({
        ...row,
        source_ids: normalized.sourceScope.mode === "selected" ? normalized.sourceScope.sourceIds : [],
        default_retrieve_enabled: syncedDefaultRetrieveSkill ? normalized.retrievalEnabled : row.default_retrieve_enabled,
        default_retrieve_config: syncedDefaultRetrieveSkill ? toDefaultRetrieveSkillConfig(normalized) : row.default_retrieve_config,
      }, this.surfaceExtensions, this.skillSettings);
    });
  }

  async listDirectives(agentId: string, workspaceId: string): Promise<AuthoredDirective[]> {
    const result = await sql<AgentDirectiveRow>`
      SELECT agent_directives.*
      FROM agent_directives
      INNER JOIN agents ON agents.id = agent_directives.agent_id
      WHERE agent_directives.agent_id = ${agentId}
        AND agents.workspace_id = ${workspaceId}
      ORDER BY agent_directives.created_at ASC, agent_directives.id ASC
    `.execute(this.db);
    return result.rows.map(mapDirectiveRow);
  }

  async createDirective(agentId: string, workspaceId: string, input: AuthoredDirectiveInput): Promise<AuthoredDirective> {
    const directive: NormalizedAuthoredDirectiveInput = authoredDirectiveInputSchema.parse(input);
    return this.db.transaction().execute(async (trx) => {
      let result: { rows: AgentDirectiveRow[] };
      try {
        result = await sql<AgentDirectiveRow>`
          INSERT INTO agent_directives (
            agent_id,
            name,
            condition_kind,
            condition_description,
            action,
            priority,
            required_capabilities,
            depends_on,
            excludes,
            routes,
            scope_tags,
            description,
            metadata
          )
          SELECT
            agents.id,
            ${directive.name},
            ${directive.condition.kind},
            ${directive.condition.kind === "contextual" ? directive.condition.description : null},
            ${directive.action},
            ${directive.priority},
            ${sql.val(directive.requiredCapabilities)}::text[],
            ${sql.val(directive.dependsOn)}::text[],
            ${sql.val(directive.excludes)}::text[],
            ${sql.val(directive.routes)}::text[],
            ${sql.val(directive.tags)}::text[],
            ${directive.description},
            ${toJsonb(directive.metadata)}
          FROM agents
          WHERE agents.id = ${agentId}
            AND agents.workspace_id = ${workspaceId}
          RETURNING *
        `.execute(trx);
      } catch (error) {
        if (isAgentDirectiveNameUniqueViolation(error)) {
          throw directiveNameConflict(directive.name);
        }
        throw error;
      }
      const row = result.rows[0];
      if (!row) {
        throw notFound("Agent not found");
      }
      return mapDirectiveRow(row);
    });
  }

  async updateDirective(
    agentId: string,
    workspaceId: string,
    directiveId: string,
    input: Partial<AuthoredDirectiveInput>,
  ): Promise<AuthoredDirective> {
    const existing = (await this.listDirectives(agentId, workspaceId)).find((directive) => directive.id === directiveId);
    if (!existing) {
      throw notFound("Directive not found");
    }
    const directive: NormalizedAuthoredDirectiveInput = authoredDirectiveInputSchema.parse({
      name: input.name ?? existing.name,
      condition: input.condition ?? existing.condition,
      action: input.action ?? existing.action,
      priority: hasOwn(input, "priority") ? input.priority : existing.priority,
      requiredCapabilities: input.requiredCapabilities ?? existing.requiredCapabilities,
      dependsOn: input.dependsOn ?? existing.dependsOn,
      excludes: input.excludes ?? existing.excludes,
      routes: input.routes ?? existing.routes,
      tags: input.tags ?? existing.tags,
      description: hasOwn(input, "description") ? input.description : existing.description,
      metadata: input.metadata ?? existing.metadata,
    });
    let rows: AgentDirectiveRow[];
    try {
      const result = await sql<AgentDirectiveRow>`
        UPDATE agent_directives
        SET name = ${directive.name},
            condition_kind = ${directive.condition.kind},
            condition_description = ${directive.condition.kind === "contextual" ? directive.condition.description : null},
            action = ${directive.action},
            priority = ${directive.priority},
            required_capabilities = ${sql.val(directive.requiredCapabilities)}::text[],
            depends_on = ${sql.val(directive.dependsOn)}::text[],
            excludes = ${sql.val(directive.excludes)}::text[],
            routes = ${sql.val(directive.routes)}::text[],
            scope_tags = ${sql.val(directive.tags)}::text[],
            description = ${directive.description},
            metadata = ${toJsonb(directive.metadata)},
            updated_at = ${currentTimestamp()}
        FROM agents
        WHERE agent_directives.id = ${directiveId}
          AND agent_directives.agent_id = ${agentId}
          AND agents.id = agent_directives.agent_id
          AND agents.workspace_id = ${workspaceId}
        RETURNING agent_directives.*
      `.execute(this.db);
      rows = result.rows;
    } catch (error) {
      if (isAgentDirectiveNameUniqueViolation(error)) {
        throw directiveNameConflict(directive.name);
      }
      throw error;
    }
    const row = rows[0];
    if (!row) {
      throw notFound("Directive not found");
    }
    return mapDirectiveRow(row);
  }

  async deleteDirective(agentId: string, workspaceId: string, directiveId: string): Promise<boolean> {
    const result = await sql`
      DELETE FROM agent_directives
      USING agents
      WHERE agent_directives.id = ${directiveId}
        AND agent_directives.agent_id = ${agentId}
        AND agents.id = agent_directives.agent_id
        AND agents.workspace_id = ${workspaceId}
    `.execute(this.db);
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  async repointRoutineScopeTags(input: RepointRoutineScopeTagsInput): Promise<RepointRoutineScopeTagsResult> {
    // A threaded transaction (when present) is a Kysely `Transaction<DB>`, assignable to
    // `Db`; otherwise run on the shared executor. This is the shared-transaction contract
    // the routine-definition repository threads its `Transaction<DB>` through.
    const db = (input.transaction as Db | undefined) ?? this.db;
    const routineTag = `routine:${input.fromDefinitionId}`;
    const stepTagPrefix = `step:${input.fromDefinitionId}:`;
    const selected = await sql<DirectiveScopeTagRow>`
      SELECT id::text, scope_tags
      FROM agent_directives
      WHERE agent_id = ${input.agentId}
        AND (
          ${routineTag} = ANY(scope_tags)
          OR EXISTS (
            SELECT 1
            FROM unnest(scope_tags) AS scope_tag
            WHERE scope_tag LIKE ${`${stepTagPrefix}%`}
          )
        )
      ORDER BY created_at ASC, id ASC
    `.execute(db);
    const rows = selected.rows;

    let repointed = 0;
    const orphans: RoutineDirectiveScopeOrphan[] = [];
    for (const row of rows) {
      let changed = false;
      const nextTags = row.scope_tags.map((tag) => {
        if (tag === routineTag) {
          changed = true;
          repointed += 1;
          return `routine:${input.toDefinitionId}`;
        }
        if (!tag.startsWith(stepTagPrefix)) {
          return tag;
        }
        const stepId = tag.slice(stepTagPrefix.length);
        if (!input.survivingStepIds.has(stepId)) {
          orphans.push({
            directiveId: row.id,
            scopeTag: tag,
            reason: "missing_step",
          });
          return tag;
        }
        changed = true;
        repointed += 1;
        return `step:${input.toDefinitionId}:${stepId}`;
      });
      if (!changed) {
        continue;
      }
      await sql`
        UPDATE agent_directives
        SET scope_tags = ${sql.val(nextTags)}::text[],
            updated_at = ${currentTimestamp()}
        WHERE id = ${row.id}
          AND agent_id = ${input.agentId}
      `.execute(db);
    }

    return { repointed, orphans };
  }

  async setDefault(workspaceId: string, agentId: string): Promise<void> {
    await this.db
      .updateTable("workspaces")
      .set({ default_agent_id: agentId, updated_at: currentTimestamp() })
      .where("id", "=", workspaceId)
      .execute();
  }

  async deleteByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("agents")
      .where("id", "=", agentId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  async countByWorkspaceId(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom("agents")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? Number(row.count) : 0;
  }

  private async replaceSourceScope(
    db: Db,
    agentId: string,
    sourceScope: NormalizedAgentInput["sourceScope"],
  ): Promise<void> {
    await db
      .deleteFrom("agent_document_sources")
      .where("agent_id", "=", agentId)
      .execute();
    const sourceIds = persistableSourceIds(sourceScope);
    if (sourceScope.mode !== "selected" || sourceIds.length === 0) {
      return;
    }
    await sql`
      INSERT INTO agent_document_sources (agent_id, source_id)
      SELECT ${agentId}::uuid, UNNEST(${sql.val(sourceIds)}::uuid[])
      ON CONFLICT DO NOTHING
    `.execute(db);
  }

  private async syncDefaultRetrieveSkill(
    db: Db,
    agentId: string,
    agent: NormalizedAgentInput,
  ): Promise<boolean> {
    const config = toDefaultRetrieveSkillConfig(agent);
    const row = await db
      .updateTable("agent_skills")
      .set({
        enabled: agent.retrievalEnabled,
        // Replace the projected retrieve config instead of shallow-merging so
        // sourceScope and renamed instruction fields cannot retain stale values.
        config: toJsonb(config),
        updated_at: currentTimestamp(),
      })
      .where("agent_id", "=", agentId)
      .where("kind", "=", "retrieve")
      .where("invocation_mode", "=", "default_answer")
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }
}
