import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import {
  mergeAgentSurfaceSettings,
  validateAgentInput,
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
      SELECT ARRAY_AGG(source_id::text ORDER BY source_id::text)
      FROM agent_document_sources
      WHERE agent_id = agents.id
    ),
    ARRAY[]::text[]
  ) AS source_ids,
  behavior_settings,
  greeting_settings,
  output_modes,
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
  logo: agent.logo,
  theme: agent.theme,
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

  const normalized = validateAgentInput({
    name: row.name,
    customInstruction: readString(behavior, "customInstruction"),
    suggestedQuestionsEnabled: readBoolean(behavior, "suggestedQuestionsEnabled"),
    retrievalEnabled: row.retrieval_enabled,
    sourceScope: row.source_scope_mode === "selected"
      ? { mode: "selected", sourceIds: row.source_ids ?? [] }
      : { mode: "all" },
    logo: (behavior.logo ?? websiteEmbedSource.logo) as AgentLogo | null | undefined,
    theme: (behavior.theme ?? websiteEmbedSource.theme) as AgentEmbedTheme | undefined,
    greetingInstruction: readString(greeting, "greetingInstruction"),
    assistantDefaultLocale: readString(greeting, "assistantDefaultLocale") ?? null,
    proactiveGreetingEnabled: readBoolean(greeting, "proactiveGreetingEnabled"),
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
  findById(agentId: string): Promise<AgentRecord | null>;
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null>;
  findDefaultByWorkspaceId(workspaceId: string): Promise<AgentRecord | null>;
  findByAnonymousChatToken(token: string): Promise<AgentRecord | null>;
  findByWebsiteEmbedToken(token: string): Promise<AgentRecord | null>;
  listByWorkspaceId(workspaceId: string): Promise<AgentRecord[]>;
  update(agentId: string, workspaceId: string, input: AgentInput): Promise<AgentRecord>;
  setDefault(workspaceId: string, agentId: string): Promise<void>;
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
           output_modes
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
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

  async findById(agentId: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns} FROM agents WHERE id = $1`,
      [agentId],
    );
    return row ? mapAgent(row, this.surfaceExtensions) : null;
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
             updated_at = NOW()
         WHERE id = $7
           AND workspace_id = $8
         RETURNING ${agentColumns}`,
        [
          normalized.name,
          normalized.retrievalEnabled,
          normalized.sourceScope.mode,
          JSON.stringify(toBehaviorSettings(normalized)),
          JSON.stringify(toGreetingSettings(normalized)),
          JSON.stringify(toOutputModes(normalized)),
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
    if (sourceScope.mode !== "selected" || sourceScope.sourceIds.length === 0) {
      return;
    }
    await client.query(
      `INSERT INTO agent_document_sources (agent_id, source_id)
       SELECT $1::uuid, UNNEST($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [agentId, sourceScope.sourceIds],
    );
  }
}
