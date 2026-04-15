import {
  defaultAssistantBootstrapSettings,
  validateAssistantBootstrapSettings,
  type AssistantBootstrapSettingsInput,
  type AssistantBootstrapSettingsRecord,
} from "../../modules/settings/domain/assistantBootstrapSettings.js";
import {
  defaultWebsiteEmbedSettings,
  validateWebsiteEmbedSettings,
  type WebsiteEmbedLauncherIcon,
  type WebsiteEmbedLauncherPosition,
  type WebsiteEmbedSettingsRecord,
} from "../../modules/settings/domain/websiteEmbedSettings.js";
import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface WorkspaceRecord extends AssistantBootstrapSettingsRecord, WebsiteEmbedSettingsRecord {
  id: string;
  accountId: string;
  name: string;
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
  assistant_name: string | null;
  assistant_role: string | null;
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
    assistantRole: row.assistant_role ?? "",
    greetingInstruction: row.greeting_instruction ?? "",
    assistantDefaultLocale: row.assistant_default_locale,
    proactiveGreetingEnabled: row.proactive_greeting_enabled ?? false,
  });
  const websiteEmbed = validateWebsiteEmbedSettings({
    websiteEmbedEnabled: row.website_embed_enabled ?? defaultWebsiteEmbedSettings().websiteEmbedEnabled,
    websiteEmbedToken: row.website_embed_token ?? null,
    websiteEmbedAllowedOrigins: row.website_embed_allowed_origins ?? [],
    websiteEmbedLauncherLabel: row.website_embed_launcher_label ?? defaultWebsiteEmbedSettings().websiteEmbedLauncherLabel,
    websiteEmbedLauncherIcon:
      (row.website_embed_launcher_icon as WebsiteEmbedLauncherIcon | null) ?? defaultWebsiteEmbedSettings().websiteEmbedLauncherIcon,
    websiteEmbedLauncherPosition:
      (row.website_embed_launcher_position as WebsiteEmbedLauncherPosition | null) ??
      defaultWebsiteEmbedSettings().websiteEmbedLauncherPosition,
  });

  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    ...bootstrap,
    ...websiteEmbed,
    anonymousChatEnabled: row.anonymous_chat_enabled ?? false,
    anonymousChatToken: row.anonymous_chat_token ?? null,
    anonymousRateLimit: row.anonymous_rate_limit ?? 10,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
};

export interface WorkspaceRepositoryPort {
  create(accountId: string, name: string): Promise<WorkspaceRecord>;
  findById(id: string): Promise<WorkspaceRecord | null>;
  findByIdAndAccountId(workspaceId: string, accountId: string): Promise<WorkspaceRecord | null>;
  findByAnonymousChatToken(token: string): Promise<WorkspaceRecord | null>;
  findByWebsiteEmbedToken(token: string): Promise<WorkspaceRecord | null>;
  listByAccountId(accountId: string): Promise<WorkspaceRecord[]>;
  countByAccountId(accountId: string): Promise<number>;
  updateName(workspaceId: string, name: string): Promise<WorkspaceRecord>;
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
      anonymousRateLimit: number;
      assistantName: string;
      assistantRole: string;
      greetingInstruction: string;
      assistantDefaultLocale: string | null;
      proactiveGreetingEnabled: boolean;
      websiteEmbedEnabled: boolean;
      websiteEmbedToken: string | null;
      websiteEmbedAllowedOrigins: string[];
      websiteEmbedLauncherLabel: string;
      websiteEmbedLauncherIcon: WebsiteEmbedLauncherIcon;
      websiteEmbedLauncherPosition: WebsiteEmbedLauncherPosition;
    },
  ): Promise<WorkspaceRecord>;
  updateAssistantBootstrapSettings(
    workspaceId: string,
    input: AssistantBootstrapSettingsInput,
  ): Promise<WorkspaceRecord>;
  deleteById(workspaceId: string): Promise<boolean>;
}

export class WorkspaceRepository implements WorkspaceRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(accountId: string, name: string): Promise<WorkspaceRecord> {
    const [row] = await this.database.query<WorkspaceRow>(
      `INSERT INTO workspaces (id, account_id, name)
       VALUES ($1, $2, $3)
       RETURNING id, account_id, name, assistant_name, assistant_role, greeting_instruction, assistant_default_locale,
                 proactive_greeting_enabled, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit,
                 website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
                 website_embed_launcher_icon, website_embed_launcher_position, created_at, updated_at`,
      [randomUUID(), accountId, name],
    );

    return mapWorkspace(row);
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.database.query<WorkspaceRow>(
      `SELECT id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at
             , assistant_name, assistant_role, greeting_instruction, assistant_default_locale, proactive_greeting_enabled
             , website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
               website_embed_launcher_icon, website_embed_launcher_position
       FROM workspaces
       WHERE id = $1`,
      [id],
    );

    return row ? mapWorkspace(row) : null;
  }

  async findByIdAndAccountId(workspaceId: string, accountId: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.database.query<WorkspaceRow>(
      `SELECT id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at
             , assistant_name, assistant_role, greeting_instruction, assistant_default_locale, proactive_greeting_enabled
             , website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
               website_embed_launcher_icon, website_embed_launcher_position
       FROM workspaces
       WHERE id = $1 AND account_id = $2`,
      [workspaceId, accountId],
    );

    return row ? mapWorkspace(row) : null;
  }

  async listByAccountId(accountId: string): Promise<WorkspaceRecord[]> {
    const rows = await this.database.query<WorkspaceRow>(
      `SELECT id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at
             , assistant_name, assistant_role, greeting_instruction, assistant_default_locale, proactive_greeting_enabled
             , website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
               website_embed_launcher_icon, website_embed_launcher_position
       FROM workspaces
       WHERE account_id = $1
       ORDER BY created_at ASC`,
      [accountId],
    );

    return rows.map(mapWorkspace);
  }

  async countByAccountId(accountId: string): Promise<number> {
    const [row] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workspaces WHERE account_id = $1`,
      [accountId],
    );

    return parseInt(row.count, 10);
  }

  async updateName(workspaceId: string, name: string): Promise<WorkspaceRecord> {
    const [row] = await this.database.query<WorkspaceRow>(
      `UPDATE workspaces SET name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, account_id, name, assistant_name, assistant_role, greeting_instruction, assistant_default_locale,
                 proactive_greeting_enabled, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit,
                 website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
                 website_embed_launcher_icon, website_embed_launcher_position, created_at, updated_at`,
      [name, workspaceId],
    );

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row);
  }

  async findByAnonymousChatToken(token: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.database.query<WorkspaceRow>(
      `SELECT id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at
             , assistant_name, assistant_role, greeting_instruction, assistant_default_locale, proactive_greeting_enabled
             , website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
               website_embed_launcher_icon, website_embed_launcher_position
       FROM workspaces
       WHERE anonymous_chat_token = $1`,
      [token],
    );

    return row ? mapWorkspace(row) : null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<WorkspaceRecord | null> {
    const [row] = await this.database.query<WorkspaceRow>(
      `SELECT id, account_id, name, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit, created_at, updated_at
             , assistant_name, assistant_role, greeting_instruction, assistant_default_locale, proactive_greeting_enabled
             , website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
               website_embed_launcher_icon, website_embed_launcher_position
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
    const [row] = await this.database.query<WorkspaceRow>(
      `UPDATE workspaces
       SET anonymous_chat_enabled = $1, anonymous_chat_token = $2, anonymous_rate_limit = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, account_id, name, assistant_name, assistant_role, greeting_instruction, assistant_default_locale,
                 proactive_greeting_enabled, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit,
                 website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
                 website_embed_launcher_icon, website_embed_launcher_position, created_at, updated_at`,
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
    const [row] = await this.database.query<WorkspaceRow>(
      `UPDATE workspaces
       SET assistant_name = $1,
           assistant_role = $2,
           greeting_instruction = $3,
           assistant_default_locale = $4,
           proactive_greeting_enabled = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, account_id, name, assistant_name, assistant_role, greeting_instruction, assistant_default_locale,
                 proactive_greeting_enabled, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit,
                 website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
                 website_embed_launcher_icon, website_embed_launcher_position, created_at, updated_at`,
      [
        normalized.assistantName,
        normalized.assistantRole,
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
      anonymousRateLimit: number;
      assistantName: string;
      assistantRole: string;
      greetingInstruction: string;
      assistantDefaultLocale: string | null;
      proactiveGreetingEnabled: boolean;
      websiteEmbedEnabled: boolean;
      websiteEmbedToken: string | null;
      websiteEmbedAllowedOrigins: string[];
      websiteEmbedLauncherLabel: string;
      websiteEmbedLauncherIcon: WebsiteEmbedLauncherIcon;
      websiteEmbedLauncherPosition: WebsiteEmbedLauncherPosition;
    },
  ): Promise<WorkspaceRecord> {
    const [row] = await this.database.query<WorkspaceRow>(
      `UPDATE workspaces
       SET anonymous_chat_enabled = $1,
           anonymous_chat_token = $2,
           anonymous_rate_limit = $3,
           assistant_name = $4,
           assistant_role = $5,
           greeting_instruction = $6,
           assistant_default_locale = $7,
           proactive_greeting_enabled = $8,
           website_embed_enabled = $9,
           website_embed_token = $10,
           website_embed_allowed_origins = $11,
           website_embed_launcher_label = $12,
           website_embed_launcher_icon = $13,
           website_embed_launcher_position = $14,
           updated_at = NOW()
       WHERE id = $15
       RETURNING id, account_id, name, assistant_name, assistant_role, greeting_instruction, assistant_default_locale,
                 proactive_greeting_enabled, anonymous_chat_enabled, anonymous_chat_token, anonymous_rate_limit,
                 website_embed_enabled, website_embed_token, website_embed_allowed_origins, website_embed_launcher_label,
                 website_embed_launcher_icon, website_embed_launcher_position, created_at, updated_at`,
      [
        input.anonymousChatEnabled,
        input.anonymousChatToken,
        input.anonymousRateLimit,
        input.assistantName,
        input.assistantRole,
        input.greetingInstruction,
        input.assistantDefaultLocale,
        input.proactiveGreetingEnabled,
        input.websiteEmbedEnabled,
        input.websiteEmbedToken,
        input.websiteEmbedAllowedOrigins,
        input.websiteEmbedLauncherLabel,
        input.websiteEmbedLauncherIcon,
        input.websiteEmbedLauncherPosition,
        workspaceId,
      ],
    );

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row);
  }

  async deleteById(workspaceId: string): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(
      `DELETE FROM workspaces WHERE id = $1 RETURNING id`,
      [workspaceId],
    );

    return rows.length > 0;
  }
}
