import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import {
  mergeAgentSurfaceSettings,
  validateAgentInput,
  type AgentInput,
  type AgentRecord,
  type AgentSurfaceIcon,
  type AgentSurfacePosition,
  type NormalizedAgentInput,
} from "../../modules/agents/public.js";

interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  retrieval_enabled: boolean;
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

const toBehaviorSettings = (agent: NormalizedAgentInput): Record<string, unknown> => ({
  customInstruction: agent.customInstruction,
  conversationMode: agent.conversationMode,
  suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
  suggestedQuestionsCount: agent.suggestedQuestionsCount,
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
    messagesPerMinute: agent.surfaceSettings.anonymousChat.messagesPerMinute,
  },
  websiteEmbed: {
    enabled: agent.surfaceSettings.websiteEmbed.enabled,
    token: agent.surfaceSettings.websiteEmbed.token,
    allowedOrigins: agent.surfaceSettings.websiteEmbed.allowedOrigins,
    launcherLabel: agent.surfaceSettings.websiteEmbed.launcherLabel,
    icon: agent.surfaceSettings.websiteEmbed.icon,
    launcherPosition: agent.surfaceSettings.websiteEmbed.launcherPosition,
  },
});

const mapAgent = (row: AgentRow): AgentRecord => {
  const behavior = asRecord(row.behavior_settings);
  const greeting = asRecord(row.greeting_settings);
  const outputModes = asRecord(row.output_modes);
  const authenticatedChat = asRecord(outputModes.authenticatedChat);
  const anonymousChat = asRecord(outputModes.anonymousChat);
  const websiteEmbed = asRecord(outputModes.websiteEmbed);

  const normalized = validateAgentInput({
    name: row.name,
    customInstruction: readString(behavior, "customInstruction"),
    conversationMode: readString(behavior, "conversationMode") as AgentInput["conversationMode"],
    suggestedQuestionsEnabled: readBoolean(behavior, "suggestedQuestionsEnabled"),
    suggestedQuestionsCount: readNumber(behavior, "suggestedQuestionsCount"),
    retrievalEnabled: row.retrieval_enabled,
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
        messagesPerMinute: readNumber(anonymousChat, "messagesPerMinute") ?? readNumber(anonymousChat, "rateLimit"),
      },
      websiteEmbed: {
        enabled: readBoolean(websiteEmbed, "enabled"),
        token: readString(websiteEmbed, "token") ?? null,
        allowedOrigins: readStringArray(websiteEmbed, "allowedOrigins"),
        launcherLabel: readString(websiteEmbed, "launcherLabel"),
        icon: readString(websiteEmbed, "icon") as AgentSurfaceIcon | undefined,
        launcherPosition: readString(websiteEmbed, "launcherPosition") as AgentSurfacePosition | undefined,
      },
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
  constructor(private readonly database: Database) {}

  async create(workspaceId: string, input: AgentInput): Promise<AgentRecord> {
    const normalized = validateAgentInput(input);
    const row = await this.database.queryOne<AgentRow>(
      `INSERT INTO agents (
         id,
         workspace_id,
         name,
         retrieval_enabled,
         behavior_settings,
         greeting_settings,
         output_modes
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
       RETURNING ${agentColumns}`,
      [
        randomUUID(),
        workspaceId,
        normalized.name,
        normalized.retrievalEnabled,
        JSON.stringify(toBehaviorSettings(normalized)),
        JSON.stringify(toGreetingSettings(normalized)),
        JSON.stringify(toOutputModes(normalized)),
      ],
    );
    return mapAgent(row);
  }

  async findById(agentId: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns} FROM agents WHERE id = $1`,
      [agentId],
    );
    return row ? mapAgent(row) : null;
  }

  async findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns} FROM agents WHERE id = $1 AND workspace_id = $2`,
      [agentId, workspaceId],
    );
    return row ? mapAgent(row) : null;
  }

  async findDefaultByWorkspaceId(workspaceId: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE id = (SELECT default_agent_id FROM workspaces WHERE id = $1)
         AND workspace_id = $1`,
      [workspaceId],
    );
    return row ? mapAgent(row) : null;
  }

  async findByAnonymousChatToken(token: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE output_modes #>> '{anonymousChat,token}' = $1`,
      [token],
    );
    return row ? mapAgent(row) : null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<AgentRecord | null> {
    const row = await this.database.queryOptional<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE output_modes #>> '{websiteEmbed,token}' = $1`,
      [token],
    );
    return row ? mapAgent(row) : null;
  }

  async listByWorkspaceId(workspaceId: string): Promise<AgentRecord[]> {
    const rows = await this.database.query<AgentRow>(
      `SELECT ${agentColumns}
       FROM agents
       WHERE workspace_id = $1
       ORDER BY created_at ASC, id ASC`,
      [workspaceId],
    );
    return rows.map(mapAgent);
  }

  async update(agentId: string, workspaceId: string, input: AgentInput): Promise<AgentRecord> {
    const current = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!current) {
      throw new Error(`Agent ${agentId} not found`);
    }
    const normalized = validateAgentInput({
      ...current,
      ...input,
      surfaceSettings: mergeAgentSurfaceSettings(current.surfaceSettings, input.surfaceSettings),
    });
    const row = await this.database.queryOne<AgentRow>(
      `UPDATE agents
       SET name = $1,
           retrieval_enabled = $2,
           behavior_settings = $3::jsonb,
           greeting_settings = $4::jsonb,
           output_modes = $5::jsonb,
           updated_at = NOW()
       WHERE id = $6
         AND workspace_id = $7
       RETURNING ${agentColumns}`,
      [
        normalized.name,
        normalized.retrievalEnabled,
        JSON.stringify(toBehaviorSettings(normalized)),
        JSON.stringify(toGreetingSettings(normalized)),
        JSON.stringify(toOutputModes(normalized)),
        agentId,
        workspaceId,
      ],
    );
    return mapAgent(row);
  }

  async setDefault(workspaceId: string, agentId: string): Promise<void> {
    await this.database.execute(
      `UPDATE workspaces SET default_agent_id = $1, updated_at = NOW() WHERE id = $2`,
      [agentId, workspaceId],
    );
  }
}
