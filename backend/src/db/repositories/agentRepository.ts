import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
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
import type { LlmProviderName } from "../../shared/infra/llm/providerTypes.js";

interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  retrieval_enabled: boolean;
  source_scope_mode: "all" | "selected";
  source_ids: string[] | null;
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

const agentColumns = `
  id,
  workspace_id,
  name,
  retrieval_enabled,
  source_scope_mode,
  COALESCE(
    (
      SELECT ARRAY_AGG(
        COALESCE(source_id::text, '${MANUALLY_ADDED_DOCUMENTS_SOURCE_ID}')
        ORDER BY source_id IS NOT NULL, source_id::text
      )
      FROM agent_document_sources
      WHERE agent_id = agents.id
    ),
    ARRAY[]::text[]
  ) AS source_ids,
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

  const normalized = validateAgentInput({
    name: row.name,
    customInstruction: readString(behavior, "customInstruction"),
    suggestedQuestionsEnabled: readBoolean(behavior, "suggestedQuestionsEnabled"),
    assistantLinkUtmEnabled: readBoolean(behavior, "assistantLinkUtmEnabled") ?? true,
    citationDisplayEnabled: readBoolean(behavior, "citationDisplayEnabled") ?? true,
    contactRequestsEnabled: readBoolean(behavior, "contactRequestsEnabled") ?? false,
    contactRequestDelivery: readContactRequestDelivery(behavior),
    retrievalEnabled: row.retrieval_enabled,
    sourceScope: row.source_scope_mode === "selected"
      ? { mode: "selected", sourceIds: row.source_ids ?? [] }
      : { mode: "all" },
    skillSettings: asRecord(row.skill_settings),
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
  setDefault(workspaceId: string, agentId: string): Promise<void>;
  deleteByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<boolean>;
  countByWorkspaceId(workspaceId: string): Promise<number>;
}

export class AgentRepository implements AgentRepositoryPort {
  constructor(
    private readonly database: Database,
    private readonly surfaceExtensions?: AgentSurfaceExtensionRegistry,
    private readonly skillSettings?: AgentSkillSettingsRegistry,
  ) {}

  async create(workspaceId: string, input: AgentInput): Promise<AgentRecord> {
    const normalized = validateAgentInput(input, {
      extensions: this.surfaceExtensions,
      skillSettings: this.skillSettings,
    });
    return this.database.withTransaction(async (client) => {
      const agentId = randomUUID();
      const result = await client.query<AgentRow>(
        `INSERT INTO agents (
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
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
         RETURNING ${agentColumns}`,
        [
          agentId,
          workspaceId,
          normalized.name,
          normalized.retrievalEnabled,
          normalized.sourceScope.mode,
          JSON.stringify(toBehaviorSettings(normalized)),
          JSON.stringify(toGreetingSettings(normalized)),
          JSON.stringify(toOutputModes(normalized)),
          JSON.stringify(toSkillSettings(normalized)),
          normalized.chatModelOverride?.provider ?? null,
          normalized.chatModelOverride?.model ?? null,
        ],
      );
      await this.replaceSourceScope(client, agentId, normalized.sourceScope);
      const row = result.rows[0];
      if (!row) {
        throw new Error("Expected created agent");
      }
      return mapAgent({
        ...row,
        source_ids: normalized.sourceScope.mode === "selected" ? normalized.sourceScope.sourceIds : [],
      }, this.surfaceExtensions, this.skillSettings);
    });
  }

  async findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns} FROM agents WHERE id = $1 AND workspace_id = $2`,
      [agentId, workspaceId],
    );
    return row ? mapAgent(row, this.surfaceExtensions, this.skillSettings) : null;
  }

  async findDefaultByWorkspaceId(workspaceId: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE id = (SELECT default_agent_id FROM workspaces WHERE id = $1)
         AND workspace_id = $1`,
      [workspaceId],
    );
    return row ? mapAgent(row, this.surfaceExtensions, this.skillSettings) : null;
  }

  async findByAnonymousChatToken(token: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE output_modes #>> '{anonymousChat,token}' = $1`,
      [token],
    );
    return row ? mapAgent(row, this.surfaceExtensions, this.skillSettings) : null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE output_modes #>> '{websiteEmbed,token}' = $1`,
      [token],
    );
    return row ? mapAgent(row, this.surfaceExtensions, this.skillSettings) : null;
  }

  async listByWorkspaceId(workspaceId: string): Promise<AgentRecord[]> {
    const rows = await this.database.query<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE workspace_id = $1
       ORDER BY created_at ASC, id ASC`,
      [workspaceId],
    );
    return rows.map((row) => mapAgent(row, this.surfaceExtensions, this.skillSettings));
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
    return this.database.withTransaction(async (client) => {
      const result = await client.query<AgentRow>(
        `UPDATE agents
         SET name = $1,
             retrieval_enabled = $2,
             source_scope_mode = $3,
             behavior_settings = $4::jsonb,
             greeting_settings = $5::jsonb,
             output_modes = $6::jsonb,
             skill_settings = $7::jsonb,
             chat_provider = $8,
             chat_model = $9,
             updated_at = NOW()
         WHERE id = $10
           AND workspace_id = $11
           AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $12::timestamptz)
         RETURNING ${agentColumns}`,
        [
          normalized.name,
          normalized.retrievalEnabled,
          normalized.sourceScope.mode,
          JSON.stringify(toBehaviorSettings(normalized)),
          JSON.stringify(toGreetingSettings(normalized)),
          JSON.stringify(toOutputModes(normalized)),
          JSON.stringify(toSkillSettings(normalized)),
          normalized.chatModelOverride?.provider ?? null,
          normalized.chatModelOverride?.model ?? null,
          agentId,
          workspaceId,
          expectedUpdatedAt,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw conflict("Agent was updated by another writer; reload before saving again");
      }
      await this.replaceSourceScope(client, agentId, normalized.sourceScope);
      return mapAgent({
        ...row,
        source_ids: normalized.sourceScope.mode === "selected" ? normalized.sourceScope.sourceIds : [],
      }, this.surfaceExtensions, this.skillSettings);
    });
  }

  async listDirectives(agentId: string, workspaceId: string): Promise<AuthoredDirective[]> {
    const rows = await this.database.query<AgentDirectiveRow>(
      `SELECT agent_directives.*
       FROM agent_directives
       INNER JOIN agents ON agents.id = agent_directives.agent_id
       WHERE agent_directives.agent_id = $1
         AND agents.workspace_id = $2
       ORDER BY agent_directives.created_at ASC, agent_directives.id ASC`,
      [agentId, workspaceId],
    );
    return rows.map(mapDirectiveRow);
  }

  async createDirective(agentId: string, workspaceId: string, input: AuthoredDirectiveInput): Promise<AuthoredDirective> {
    const directive: NormalizedAuthoredDirectiveInput = authoredDirectiveInputSchema.parse(input);
    return this.database.withTransaction(async (client) => {
      let result: { rows: AgentDirectiveRow[] };
      try {
        result = await client.query<AgentDirectiveRow>(
          `INSERT INTO agent_directives (
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
             $3,
             $4,
             $5,
             $6,
             NULL,
             $7::text[],
             $8::text[],
             $9::text[],
             $10::text[],
             $11::text[],
             $12,
             $13::jsonb
           FROM agents
           WHERE agents.id = $1
             AND agents.workspace_id = $2
           RETURNING *`,
          [
            agentId,
            workspaceId,
            directive.name,
            directive.condition.kind,
            directive.condition.kind === "contextual" ? directive.condition.description : null,
            directive.action,
            directive.requiredCapabilities,
            directive.dependsOn,
            directive.excludes,
            directive.routes,
            directive.tags,
            directive.description,
            JSON.stringify(directive.metadata),
          ],
        );
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
      rows = await this.database.query<AgentDirectiveRow>(
        `UPDATE agent_directives
         SET name = $4,
             condition_kind = $5,
             condition_description = $6,
             action = $7,
             required_capabilities = $8::text[],
             depends_on = $9::text[],
             excludes = $10::text[],
             routes = $11::text[],
             scope_tags = $12::text[],
             description = $13,
             metadata = $14::jsonb,
             updated_at = NOW()
         FROM agents
         WHERE agent_directives.id = $1
           AND agent_directives.agent_id = $2
           AND agents.id = agent_directives.agent_id
           AND agents.workspace_id = $3
         RETURNING agent_directives.*`,
        [
          directiveId,
          agentId,
          workspaceId,
          directive.name,
          directive.condition.kind,
          directive.condition.kind === "contextual" ? directive.condition.description : null,
          directive.action,
          directive.requiredCapabilities,
          directive.dependsOn,
          directive.excludes,
          directive.routes,
          directive.tags,
          directive.description,
          JSON.stringify(directive.metadata),
        ],
      );
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
    const affected = await this.database.execute(
      `DELETE FROM agent_directives
       USING agents
       WHERE agent_directives.id = $1
         AND agent_directives.agent_id = $2
         AND agents.id = agent_directives.agent_id
         AND agents.workspace_id = $3`,
      [directiveId, agentId, workspaceId],
    );
    return affected > 0;
  }

  async setDefault(workspaceId: string, agentId: string): Promise<void> {
    await this.database.execute(
      `UPDATE workspaces SET default_agent_id = $1, updated_at = NOW() WHERE id = $2`,
      [agentId, workspaceId],
    );
  }

  async deleteByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<boolean> {
    const affected = await this.database.execute(
      `DELETE FROM agents WHERE id = $1 AND workspace_id = $2`,
      [agentId, workspaceId],
    );
    return affected > 0;
  }

  async countByWorkspaceId(workspaceId: string): Promise<number> {
    const row = await this.database.queryOptional<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agents WHERE workspace_id = $1`,
      [workspaceId],
    );
    return row ? Number(row.count) : 0;
  }

  private async replaceSourceScope(
    client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
    agentId: string,
    sourceScope: NormalizedAgentInput["sourceScope"],
  ): Promise<void> {
    await client.query(
      `DELETE FROM agent_document_sources
       WHERE agent_id = $1`,
      [agentId],
    );
    const sourceIds = persistableSourceIds(sourceScope);
    if (sourceScope.mode !== "selected" || sourceIds.length === 0) {
      return;
    }
    await client.query(
      `INSERT INTO agent_document_sources (agent_id, source_id)
       SELECT $1::uuid, UNNEST($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [agentId, sourceIds],
    );
  }
}
