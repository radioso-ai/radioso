import {
  defaultAssistantBootstrapSettings,
  validateAssistantBootstrapSettings,
  type AssistantBootstrapSettingsInput,
  type AssistantBootstrapSettingsRecord,
} from "../../modules/settings/contracts/assistantBootstrap.js";
import {
  defaultWebsiteEmbedSettings,
  validateWebsiteEmbedSettings,
  type WebsiteEmbedLauncherPosition,
  type WebsiteEmbedSettingsRecord,
} from "../../modules/settings/contracts/websiteEmbed.js";
import { createWorkspacePublicRouteKey } from "../../modules/workspace/domain/publicRouteKey.js";
import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface WorkspaceRecord extends AssistantBootstrapSettingsRecord, WebsiteEmbedSettingsRecord {
  id: string;
  accountId: string;
  name: string;
  publicRouteKey: string;
  defaultAgentId: string | null;
  anonymousChatEnabled: boolean;
  anonymousChatToken: string | null;
  anonymousRateLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkspaceRow {
  id: string;
  account_id: string;
  name: string;
  public_route_key: string;
  default_agent_id: string | null;
  assistant_name: string | null;
  greeting_instruction: string | null;
  assistant_default_locale: string | null;
  proactive_greeting_enabled: boolean | null;
  anonymous_chat_enabled: boolean;
  anonymous_chat_token: string | null;
  anonymous_rate_limit: number;
  website_embed_enabled: boolean | null;
  website_embed_token: string | null;
  website_embed_allowed_origins: string[] | null;
  website_embed_launcher_label: string | null;
  website_embed_launcher_icon: string | null;
  website_embed_launcher_position: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapWorkspace = (row: WorkspaceRow): WorkspaceRecord => {
  const bootstrap = validateAssistantBootstrapSettings({
    assistantName: row.assistant_name ?? "",
    greetingInstruction: row.greeting_instruction ?? "",
    assistantDefaultLocale: row.assistant_default_locale,
    proactiveGreetingEnabled: row.proactive_greeting_enabled ?? false,
  });
  const websiteEmbed = validateWebsiteEmbedSettings({
    websiteEmbedEnabled: row.website_embed_enabled ?? defaultWebsiteEmbedSettings().websiteEmbedEnabled,
    websiteEmbedToken: row.website_embed_token ?? null,
    websiteEmbedAllowedOrigins: row.website_embed_allowed_origins ?? [],
    websiteEmbedLauncherLabel: row.website_embed_launcher_label ?? defaultWebsiteEmbedSettings().websiteEmbedLauncherLabel,
    websiteEmbedLauncherPosition:
      (row.website_embed_launcher_position as WebsiteEmbedLauncherPosition | null) ??
      defaultWebsiteEmbedSettings().websiteEmbedLauncherPosition,
  });

  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    publicRouteKey: row.public_route_key,
    defaultAgentId: row.default_agent_id ?? null,
    ...bootstrap,
    ...websiteEmbed,
    anonymousChatEnabled: row.anonymous_chat_enabled ?? false,
    anonymousChatToken: row.anonymous_chat_token ?? null,
    anonymousRateLimit: row.anonymous_rate_limit ?? 10,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
};

const workspaceColumns = `
  id,
  account_id,
  name,
  public_route_key,
  default_agent_id,
  assistant_name,
  greeting_instruction,
  assistant_default_locale,
  proactive_greeting_enabled,
  anonymous_chat_enabled,
  anonymous_chat_token,
  anonymous_rate_limit,
  website_embed_enabled,
  website_embed_token,
  website_embed_allowed_origins,
  website_embed_launcher_label,
  website_embed_launcher_icon,
  website_embed_launcher_position,
  created_at,
  updated_at
`;

export interface WorkspaceRepositoryPort {
  create(accountId: string, name: string, publicRouteKey?: string): Promise<WorkspaceRecord>;
  findById(id: string): Promise<WorkspaceRecord | null>;
  findByIdAndAccountId(workspaceId: string, accountId: string): Promise<WorkspaceRecord | null>;
  findByPublicRouteKey(publicRouteKey: string): Promise<WorkspaceRecord | null>;
  findByAnonymousChatToken(token: string): Promise<WorkspaceRecord | null>;
  findByWebsiteEmbedToken(token: string): Promise<WorkspaceRecord | null>;
  listByAccountId(accountId: string): Promise<WorkspaceRecord[]>;
  countByAccountId(accountId: string): Promise<number>;
  updateName(workspaceId: string, accountId: string, name: string): Promise<WorkspaceRecord>;
  updateAnonymousChatSettings(
    workspaceId: string,
    enabled: boolean,
    token: string | null,
    rateLimit: number,
  ): Promise<WorkspaceRecord>;
  updateGeneralSettings(
    workspaceId: string,
    input: {
      anonymousChatEnabled: boolean;
      anonymousChatToken: string | null;
      assistantName: string;
      greetingInstruction: string;
      assistantDefaultLocale: string | null;
      proactiveGreetingEnabled: boolean;
      websiteEmbedEnabled: boolean;
      websiteEmbedToken: string | null;
      websiteEmbedAllowedOrigins: string[];
      websiteEmbedLauncherLabel: string;
      websiteEmbedLauncherPosition: WebsiteEmbedLauncherPosition;
    },
  ): Promise<WorkspaceRecord>;
  updateAssistantBootstrapSettings(
    workspaceId: string,
    input: AssistantBootstrapSettingsInput,
  ): Promise<WorkspaceRecord>;
  deleteByIdAndAccountId(workspaceId: string, accountId: string): Promise<boolean>;
}

export class WorkspaceRepository implements WorkspaceRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(accountId: string, name: string, publicRouteKey?: string): Promise<WorkspaceRecord> {
    const row = await this.database.queryOne<WorkspaceRow>(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)
       RETURNING ${workspaceColumns}`,
      [randomUUID(), accountId, name, publicRouteKey ?? createWorkspacePublicRouteKey(name)],
    );

    return mapWorkspace(row);
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {
    const row = await this.database.queryOptional<WorkspaceRow>(
      `SELECT ${workspaceColumns}
       FROM workspaces
       WHERE id = $1`,
      [id],
    );

    return row ? mapWorkspace(row) : null;
  }

  async findByIdAndAccountId(workspaceId: string, accountId: string): Promise<WorkspaceRecord | null> {
    const row = await this.database.queryOptional<WorkspaceRow>(
      `SELECT ${workspaceColumns}
       FROM workspaces
       WHERE id = $1 AND account_id = $2`,
      [workspaceId, accountId],
    );

    return row ? mapWorkspace(row) : null;
  }

  async findByPublicRouteKey(publicRouteKey: string): Promise<WorkspaceRecord | null> {
    const row = await this.database.queryOptional<WorkspaceRow>(
      `SELECT ${workspaceColumns}
       FROM workspaces
       WHERE public_route_key = $1`,
      [publicRouteKey],
    );

    return row ? mapWorkspace(row) : null;
  }

  async listByAccountId(accountId: string): Promise<WorkspaceRecord[]> {
    const rows = await this.database.query<WorkspaceRow>(
      `SELECT ${workspaceColumns}
       FROM workspaces
       WHERE account_id = $1
       ORDER BY created_at ASC`,
      [accountId],
    );

    return rows.map(mapWorkspace);
  }

  async countByAccountId(accountId: string): Promise<number> {
    const row = await this.database.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workspaces WHERE account_id = $1`,
      [accountId],
    );

    return parseInt(row.count, 10);
  }

  async updateName(workspaceId: string, accountId: string, name: string): Promise<WorkspaceRecord> {
    const row = await this.database.queryOptional<WorkspaceRow>(
      `UPDATE workspaces SET name = $1, updated_at = NOW()
       WHERE id = $2
         AND account_id = $3
       RETURNING ${workspaceColumns}`,
      [name, workspaceId, accountId],
    );

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row);
  }

  async findByAnonymousChatToken(token: string): Promise<WorkspaceRecord | null> {
    const row = await this.database.queryOptional<WorkspaceRow>(
      `SELECT ${workspaceColumns}
       FROM workspaces
       WHERE anonymous_chat_token = $1`,
      [token],
    );

    return row ? mapWorkspace(row) : null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<WorkspaceRecord | null> {
    const row = await this.database.queryOptional<WorkspaceRow>(
      `SELECT ${workspaceColumns}
       FROM workspaces
       WHERE website_embed_token = $1`,
      [token],
    );

    return row ? mapWorkspace(row) : null;
  }

  async updateAnonymousChatSettings(
    workspaceId: string,
    enabled: boolean,
    token: string | null,
    rateLimit: number,
  ): Promise<WorkspaceRecord> {
    const row = await this.database.queryOptional<WorkspaceRow>(
      `UPDATE workspaces
       SET anonymous_chat_enabled = $1, anonymous_chat_token = $2, anonymous_rate_limit = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING ${workspaceColumns}`,
      [enabled, token, rateLimit, workspaceId],
    );

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row);
  }

  async updateAssistantBootstrapSettings(
    workspaceId: string,
    input: AssistantBootstrapSettingsInput,
  ): Promise<WorkspaceRecord> {
    const normalized = validateAssistantBootstrapSettings({
      ...defaultAssistantBootstrapSettings(),
      ...input,
    });
    const row = await this.database.queryOptional<WorkspaceRow>(
      `UPDATE workspaces
       SET assistant_name = $1,
           greeting_instruction = $2,
           assistant_default_locale = $3,
           proactive_greeting_enabled = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING ${workspaceColumns}`,
      [
        normalized.assistantName,
        normalized.greetingInstruction,
        normalized.assistantDefaultLocale,
        normalized.proactiveGreetingEnabled,
        workspaceId,
      ],
    );

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row);
  }

  async updateGeneralSettings(
    workspaceId: string,
    input: {
      anonymousChatEnabled: boolean;
      anonymousChatToken: string | null;
      assistantName: string;
      greetingInstruction: string;
      assistantDefaultLocale: string | null;
      proactiveGreetingEnabled: boolean;
      websiteEmbedEnabled: boolean;
      websiteEmbedToken: string | null;
      websiteEmbedAllowedOrigins: string[];
      websiteEmbedLauncherLabel: string;
      websiteEmbedLauncherPosition: WebsiteEmbedLauncherPosition;
    },
  ): Promise<WorkspaceRecord> {
    const row = await this.database.queryOptional<WorkspaceRow>(
      `UPDATE workspaces
       SET anonymous_chat_enabled = $1,
           anonymous_chat_token = $2,
           assistant_name = $3,
           greeting_instruction = $4,
           assistant_default_locale = $5,
           proactive_greeting_enabled = $6,
           website_embed_enabled = $7,
           website_embed_token = $8,
           website_embed_allowed_origins = $9,
           website_embed_launcher_label = $10,
           website_embed_launcher_position = $11,
           updated_at = NOW()
       WHERE id = $12
       RETURNING ${workspaceColumns}`,
      [
        input.anonymousChatEnabled,
        input.anonymousChatToken,
        input.assistantName,
        input.greetingInstruction,
        input.assistantDefaultLocale,
        input.proactiveGreetingEnabled,
        input.websiteEmbedEnabled,
        input.websiteEmbedToken,
        input.websiteEmbedAllowedOrigins,
        input.websiteEmbedLauncherLabel,
        input.websiteEmbedLauncherPosition,
        workspaceId,
      ],
    );

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row);
  }

  async deleteByIdAndAccountId(workspaceId: string, accountId: string): Promise<boolean> {
    return (
      (await this.database.execute(
        "DELETE FROM workspaces WHERE id = $1 AND account_id = $2",
        [workspaceId, accountId],
      )) > 0
    );
  }
}
