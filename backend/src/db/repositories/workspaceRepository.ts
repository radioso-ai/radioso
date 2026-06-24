import {
  defaultAssistantBootstrapSettings,
  validateAssistantBootstrapSettings,
  type AssistantBootstrapSettingsInput,
  type AssistantBootstrapSettingsRecord,
} from "../../modules/settings/contracts/assistantBootstrap.js";
import {
  coerceWebsiteEmbedSettings,
  defaultWebsiteEmbedSettings,
  type WebsiteEmbedLauncherPosition,
  type WebsiteEmbedSettingsRecord,
} from "../../modules/settings/contracts/websiteEmbed.js";
import { createWorkspacePublicRouteKey } from "../../modules/workspace/domain/publicRouteKey.js";
import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

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
  const websiteEmbed = coerceWebsiteEmbedSettings({
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

const workspaceColumns = [
  "id",
  "account_id",
  "name",
  "public_route_key",
  "default_agent_id",
  "assistant_name",
  "greeting_instruction",
  "assistant_default_locale",
  "proactive_greeting_enabled",
  "anonymous_chat_enabled",
  "anonymous_chat_token",
  "anonymous_rate_limit",
  "website_embed_enabled",
  "website_embed_token",
  "website_embed_allowed_origins",
  "website_embed_launcher_label",
  "website_embed_launcher_icon",
  "website_embed_launcher_position",
  "created_at",
  "updated_at",
] as const;

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
  constructor(private readonly db: Db) {}

  async create(accountId: string, name: string, publicRouteKey?: string): Promise<WorkspaceRecord> {
    const row = await this.db
      .insertInto("workspaces")
      .values({
        id: randomUUID(),
        account_id: accountId,
        name,
        public_route_key: publicRouteKey ?? createWorkspacePublicRouteKey(name),
      })
      .returning(workspaceColumns)
      .executeTakeFirstOrThrow();

    return mapWorkspace(row as WorkspaceRow);
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select(workspaceColumns)
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapWorkspace(row as WorkspaceRow) : null;
  }

  async findByIdAndAccountId(workspaceId: string, accountId: string): Promise<WorkspaceRecord | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select(workspaceColumns)
      .where("id", "=", workspaceId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();

    return row ? mapWorkspace(row as WorkspaceRow) : null;
  }

  async findByPublicRouteKey(publicRouteKey: string): Promise<WorkspaceRecord | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select(workspaceColumns)
      .where("public_route_key", "=", publicRouteKey)
      .executeTakeFirst();

    return row ? mapWorkspace(row as WorkspaceRow) : null;
  }

  async listByAccountId(accountId: string): Promise<WorkspaceRecord[]> {
    const rows = await this.db
      .selectFrom("workspaces")
      .select(workspaceColumns)
      .where("account_id", "=", accountId)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => mapWorkspace(row as WorkspaceRow));
  }

  async countByAccountId(accountId: string): Promise<number> {
    const row = await this.db
      .selectFrom("workspaces")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("account_id", "=", accountId)
      .executeTakeFirstOrThrow();

    return parseInt(row.count, 10);
  }

  async updateName(workspaceId: string, accountId: string, name: string): Promise<WorkspaceRecord> {
    const row = await this.db
      .updateTable("workspaces")
      .set({ name, updated_at: currentTimestamp() })
      .where("id", "=", workspaceId)
      .where("account_id", "=", accountId)
      .returning(workspaceColumns)
      .executeTakeFirst();

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row as WorkspaceRow);
  }

  async findByAnonymousChatToken(token: string): Promise<WorkspaceRecord | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select(workspaceColumns)
      .where("anonymous_chat_token", "=", token)
      .executeTakeFirst();

    return row ? mapWorkspace(row as WorkspaceRow) : null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<WorkspaceRecord | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select(workspaceColumns)
      .where("website_embed_token", "=", token)
      .executeTakeFirst();

    return row ? mapWorkspace(row as WorkspaceRow) : null;
  }

  async updateAnonymousChatSettings(
    workspaceId: string,
    enabled: boolean,
    token: string | null,
    rateLimit: number,
  ): Promise<WorkspaceRecord> {
    const row = await this.db
      .updateTable("workspaces")
      .set({
        anonymous_chat_enabled: enabled,
        anonymous_chat_token: token,
        anonymous_rate_limit: rateLimit,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", workspaceId)
      .returning(workspaceColumns)
      .executeTakeFirst();

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row as WorkspaceRow);
  }

  async updateAssistantBootstrapSettings(
    workspaceId: string,
    input: AssistantBootstrapSettingsInput,
  ): Promise<WorkspaceRecord> {
    const normalized = validateAssistantBootstrapSettings({
      ...defaultAssistantBootstrapSettings(),
      ...input,
    });
    const row = await this.db
      .updateTable("workspaces")
      .set({
        assistant_name: normalized.assistantName,
        greeting_instruction: normalized.greetingInstruction,
        assistant_default_locale: normalized.assistantDefaultLocale,
        proactive_greeting_enabled: normalized.proactiveGreetingEnabled,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", workspaceId)
      .returning(workspaceColumns)
      .executeTakeFirst();

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row as WorkspaceRow);
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
    const row = await this.db
      .updateTable("workspaces")
      .set({
        anonymous_chat_enabled: input.anonymousChatEnabled,
        anonymous_chat_token: input.anonymousChatToken,
        assistant_name: input.assistantName,
        greeting_instruction: input.greetingInstruction,
        assistant_default_locale: input.assistantDefaultLocale,
        proactive_greeting_enabled: input.proactiveGreetingEnabled,
        website_embed_enabled: input.websiteEmbedEnabled,
        website_embed_token: input.websiteEmbedToken,
        website_embed_allowed_origins: input.websiteEmbedAllowedOrigins,
        website_embed_launcher_label: input.websiteEmbedLauncherLabel,
        website_embed_launcher_position: input.websiteEmbedLauncherPosition,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", workspaceId)
      .returning(workspaceColumns)
      .executeTakeFirst();

    if (!row) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    return mapWorkspace(row as WorkspaceRow);
  }

  async deleteByIdAndAccountId(workspaceId: string, accountId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("workspaces")
      .where("id", "=", workspaceId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
