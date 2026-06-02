import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
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
  type AgentSurfacePosition,
  type NormalizedAgentInput,
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
  chat_provider: LlmProviderName | null;
  chat_model: string | null;
  created_at: Date;
  updated_at: Date;
}

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
  chat_provider,
  chat_model,
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

const persistableSourceIds = (sourceScope: NormalizedAgentInput["sourceScope"]): Array<string | null> =>
  sourceScope.mode === "selected"
    ? sourceScope.sourceIds.map((sourceId) => sourceId === MANUALLY_ADDED_DOCUMENTS_SOURCE_ID ? null : sourceId)
    : [];

const mapAgent = (row: AgentRow, surfaceExtensions?: AgentSurfaceExtensionRegistry): AgentRecord => {
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
    retrievalEnabled: row.retrieval_enabled,
    sourceScope: row.source_scope_mode === "selected"
      ? { mode: "selected", sourceIds: row.source_ids ?? [] }
      : { mode: "all" },
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
  });

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...normalized,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
};

export interface AgentRepositoryPort {
  create(workspaceId: string, input: AgentInput): Promise<AgentRecord>;
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null>;
  findDefaultByWorkspaceId(workspaceId: string): Promise<AgentRecord | null>;
  findByAnonymousChatToken(token: string): Promise<AgentRecord | null>;
  findByWebsiteEmbedToken(token: string): Promise<AgentRecord | null>;
  listByWorkspaceId(workspaceId: string): Promise<AgentRecord[]>;
  update(agentId: string, workspaceId: string, input: AgentInput): Promise<AgentRecord>;
  setDefault(workspaceId: string, agentId: string): Promise<void>;
  deleteByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<boolean>;
  countByWorkspaceId(workspaceId: string): Promise<number>;
}

export class AgentRepository implements AgentRepositoryPort {
  constructor(
    private readonly database: Database,
    private readonly surfaceExtensions?: AgentSurfaceExtensionRegistry,
  ) {}

  async create(workspaceId: string, input: AgentInput): Promise<AgentRecord> {
    const normalized = validateAgentInput(input, { extensions: this.surfaceExtensions });
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
           chat_provider,
           chat_model
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
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
      }, this.surfaceExtensions);
    });
  }

  async findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns} FROM agents WHERE id = $1 AND workspace_id = $2`,
      [agentId, workspaceId],
    );
    return row ? mapAgent(row, this.surfaceExtensions) : null;
  }

  async findDefaultByWorkspaceId(workspaceId: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE id = (SELECT default_agent_id FROM workspaces WHERE id = $1)
         AND workspace_id = $1`,
      [workspaceId],
    );
    return row ? mapAgent(row, this.surfaceExtensions) : null;
  }

  async findByAnonymousChatToken(token: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE output_modes #>> '{anonymousChat,token}' = $1`,
      [token],
    );
    return row ? mapAgent(row, this.surfaceExtensions) : null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE output_modes #>> '{websiteEmbed,token}' = $1`,
      [token],
    );
    return row ? mapAgent(row, this.surfaceExtensions) : null;
  }

  async listByWorkspaceId(workspaceId: string): Promise<AgentRecord[]> {
    const rows = await this.database.query<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE workspace_id = $1
       ORDER BY created_at ASC, id ASC`,
      [workspaceId],
    );
    return rows.map((row) => mapAgent(row, this.surfaceExtensions));
  }

  async update(agentId: string, workspaceId: string, input: AgentInput): Promise<AgentRecord> {
    const current = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!current) {
      throw new Error(`Agent ${agentId} not found`);
    }
    const normalized = validateAgentInput(
      {
        ...current,
        ...input,
        surfaceSettings: mergeAgentSurfaceSettings(current.surfaceSettings, input.surfaceSettings),
      },
      { extensions: this.surfaceExtensions },
    );
    return this.database.withTransaction(async (client) => {
      const result = await client.query<AgentRow>(
        `UPDATE agents
         SET name = $1,
             retrieval_enabled = $2,
             source_scope_mode = $3,
             behavior_settings = $4::jsonb,
             greeting_settings = $5::jsonb,
             output_modes = $6::jsonb,
             chat_provider = $7,
             chat_model = $8,
             updated_at = NOW()
         WHERE id = $9
           AND workspace_id = $10
         RETURNING ${agentColumns}`,
        [
          normalized.name,
          normalized.retrievalEnabled,
          normalized.sourceScope.mode,
          JSON.stringify(toBehaviorSettings(normalized)),
          JSON.stringify(toGreetingSettings(normalized)),
          JSON.stringify(toOutputModes(normalized)),
          normalized.chatModelOverride?.provider ?? null,
          normalized.chatModelOverride?.model ?? null,
          agentId,
          workspaceId,
        ],
      );
      await this.replaceSourceScope(client, agentId, normalized.sourceScope);
      const row = result.rows[0];
      if (!row) {
        throw new Error(`Agent ${agentId} not found`);
      }
      return mapAgent({
        ...row,
        source_ids: normalized.sourceScope.mode === "selected" ? normalized.sourceScope.sourceIds : [],
      }, this.surfaceExtensions);
    });
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
