import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";

import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import { conflict, notFound } from "../../../shared/domain/errors.js";
import type {
  CreateOauthConnectionInput,
  OauthConnectionRecord,
  OauthConnectionRepositoryPort,
} from "../../../db/repositories/oauthConnectionRepository.js";
import {
  decryptOauthTokens,
  encryptOauthTokens,
  type StoredOauthTokens,
} from "../../integrationOauth/public.js";
import type {
  IntegrationConnectionRecord,
  IntegrationConnectionRepositoryPort,
} from "../../integrationConnections/public.js";
import { slackBotScopes } from "../manifest/slackManifest.js";

export interface SlackInstallationRecord {
  id: string;
  connectionId: string;
  workspaceId: string;
  accountId: string;
  teamId: string;
  teamName: string | null;
  botUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SlackChannelBindingRecord {
  id: string;
  installationId: string;
  workspaceId: string;
  // null = the default answerer for the installation (DMs + channels with no explicit binding).
  channelId: string | null;
  answeringAgentId: string;
  escalationChannelId: string | null;
  gapEscalationEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertSlackInstallationInput {
  connectionId: string;
  workspaceId: string;
  accountId: string;
  teamId: string;
  teamName?: string | null;
  botUserId: string;
}

export interface UpsertSlackBindingInput {
  installationId: string;
  workspaceId: string;
  // Omitted/null targets the installation's default answerer; a value binds a specific channel.
  channelId?: string | null;
  answeringAgentId: string;
  escalationChannelId?: string | null;
  gapEscalationEnabled?: boolean;
}

export interface SlackInstallationRepositoryPort {
  findById(installationId: string): Promise<SlackInstallationRecord | null>;
  findByTeamId(teamId: string): Promise<SlackInstallationRecord | null>;
  findByWorkspaceId(workspaceId: string): Promise<SlackInstallationRecord | null>;
  findByAccountId(accountId: string): Promise<SlackInstallationRecord | null>;
  upsert(input: UpsertSlackInstallationInput): Promise<SlackInstallationRecord>;
  removeByWorkspaceId(workspaceId: string): Promise<boolean>;
}

export interface SlackBindingRepositoryPort {
  /** The installation's default answerer (channel_id IS NULL). */
  findByInstallationId(installationId: string): Promise<SlackChannelBindingRecord | null>;
  /**
   * Resolve the answering binding for an inbound event: the channel-specific binding when one
   * exists, otherwise the installation default. Pass null for surfaces without a routable channel
   * (DMs) to resolve straight to the default.
   */
  findAnswerer(installationId: string, channelId: string | null): Promise<SlackChannelBindingRecord | null>;
  upsert(input: UpsertSlackBindingInput): Promise<SlackChannelBindingRecord>;
  removeByInstallationId(installationId: string): Promise<boolean>;
}

export interface SlackInstallationServiceOptions {
  oauthConnections: Pick<OauthConnectionRepositoryPort, "create" | "findById" | "setOauthTokens"> & {
    remove?: OauthConnectionRepositoryPort["remove"];
  };
  integrationConnections: Pick<IntegrationConnectionRepositoryPort, "create" | "findById" | "update" | "remove">;
  installations: SlackInstallationRepositoryPort;
  bindings: SlackBindingRepositoryPort;
  workspaceAccounts: WorkspaceAccountLookup;
  encryptionKey?: string;
}

export interface WorkspaceAccountLookup {
  getAccountId(workspaceId: string): Promise<string | null>;
}

export interface SaveSlackInstallationInput {
  workspaceId: string;
  oauthConnectionId?: string;
  teamId: string;
  teamName?: string | null;
  botUserId: string;
  botAccessToken: string;
  grantedScopes: string[];
  answeringAgentId?: string;
  escalationChannelId?: string | null;
  gapEscalationEnabled?: boolean;
}

export interface SaveSlackInstallationResult {
  oauthConnection: OauthConnectionRecord;
  connection: IntegrationConnectionRecord;
  installation: SlackInstallationRecord;
  binding: SlackChannelBindingRecord | null;
}

export interface SlackInstallationStatus {
  status: "connected" | "needs_reauth" | "disabled" | "not_configured";
  installationId?: string;
  teamName?: string;
  answeringAgentId?: string;
}

const displayNameForTeam = (teamName: string | null | undefined, teamId: string): string =>
  teamName?.trim() || `Slack ${teamId}`;

const toStoredTokens = (input: SaveSlackInstallationInput): StoredOauthTokens => ({
  accessToken: input.botAccessToken,
  tokenType: "bot",
  ...(input.grantedScopes.length > 0 ? { scope: input.grantedScopes.join(" ") } : {}),
});

const normalizeGrantedScopes = (grantedScopes: readonly string[]): Set<string> =>
  new Set(grantedScopes.flatMap((scope) => scope.split(/[,\s]+/u)).filter(Boolean));

const hasRequiredSlackBotScopes = (grantedScopes: readonly string[]): boolean => {
  const granted = normalizeGrantedScopes(grantedScopes);
  return slackBotScopes.every((scope) => granted.has(scope));
};

export class SlackInstallationService {
  constructor(private readonly options: SlackInstallationServiceOptions) {}

  async saveInstallation(input: SaveSlackInstallationInput): Promise<SaveSlackInstallationResult> {
    const key = this.requireEncryptionKey();
    const installingAccountId = await this.requireAccountId(input.workspaceId);
    const existingInstallation = await this.options.installations.findByTeamId(input.teamId);
    const displayName = displayNameForTeam(input.teamName, input.teamId);
    if (existingInstallation && existingInstallation.accountId !== installingAccountId) {
      throw conflict("Slack workspace is already connected to another organization");
    }

    const existingConnection = existingInstallation
      ? await this.integrationConnectionForInstallation(existingInstallation)
      : null;
    const previousOauthConnectionId = existingConnection?.oauthConnectionId ?? null;
    const moveCredentialHome = Boolean(
      existingConnection && input.oauthConnectionId && existingConnection.workspaceId !== input.workspaceId,
    );
    const credentialWorkspaceId = moveCredentialHome ? input.workspaceId : existingConnection?.workspaceId ?? input.workspaceId;
    const oauthConnectionId = existingConnection
      ? input.oauthConnectionId ?? existingConnection.oauthConnectionId
      : input.oauthConnectionId ?? (await this.createOauthConnection(input.workspaceId, displayName, input.teamId)).id;

    const oauthConnection = await this.writeOauthTokens(input, credentialWorkspaceId, oauthConnectionId, key, displayName);
    const connection = existingConnection
      ? moveCredentialHome
        ? await this.options.integrationConnections.create({
            workspaceId: input.workspaceId,
            oauthConnectionId: oauthConnection.id,
            provider: "slack",
            displayName,
            status: "authorized",
            config: {},
          })
        : await this.refreshIntegrationConnection(existingConnection, displayName, oauthConnection.id)
      : await this.options.integrationConnections.create({
          workspaceId: input.workspaceId,
          oauthConnectionId: oauthConnection.id,
          provider: "slack",
          displayName,
          status: "authorized",
          config: {},
        });
    if (previousOauthConnectionId && previousOauthConnectionId !== oauthConnection.id) {
      await this.options.oauthConnections.remove?.(existingConnection?.workspaceId ?? credentialWorkspaceId, previousOauthConnectionId);
    }

    const installation = await this.options.installations.upsert({
      connectionId: connection.id,
      workspaceId: connection.workspaceId,
      accountId: installingAccountId,
      teamId: input.teamId,
      teamName: input.teamName ?? null,
      botUserId: input.botUserId,
    });
    if (moveCredentialHome && existingConnection) {
      await this.options.integrationConnections.remove(existingConnection.workspaceId, existingConnection.id, ["slack"]);
    }
    const binding = input.answeringAgentId
      ? await this.options.bindings.upsert({
          installationId: installation.id,
          workspaceId: input.workspaceId,
          answeringAgentId: input.answeringAgentId,
          escalationChannelId: input.escalationChannelId ?? null,
          gapEscalationEnabled: input.gapEscalationEnabled ?? false,
        })
      : await this.options.bindings.findByInstallationId(installation.id);

    return { oauthConnection, connection, installation, binding };
  }

  async getStatus(workspaceId: string): Promise<SlackInstallationStatus> {
    const installation = await this.findInstallationForWorkspace(workspaceId);
    if (!installation) {
      return { status: "not_configured" };
    }
    const connection = await this.options.integrationConnections.findById(installation.workspaceId, installation.connectionId, ["slack"]);
    if (!connection) {
      return { status: "not_configured" };
    }
    const oauthConnection = await this.options.oauthConnections.findById(installation.workspaceId, connection.oauthConnectionId);
    const binding = await this.options.bindings.findByInstallationId(installation.id);
    const status = connection.status === "authorized" && oauthConnection && !hasRequiredSlackBotScopes(oauthConnection.grantedScopes)
      ? "needs_reauth"
      : connection.status === "authorized"
        ? "connected"
        : connection.status === "error"
          ? "needs_reauth"
          : connection.status;
    return {
      status,
      installationId: installation.id,
      ...(installation.teamName ? { teamName: installation.teamName } : {}),
      ...(binding?.answeringAgentId ? { answeringAgentId: binding.answeringAgentId } : {}),
    };
  }

  async getBinding(workspaceId: string): Promise<SlackChannelBindingRecord | null> {
    const installation = await this.findInstallationForWorkspace(workspaceId);
    return installation ? this.options.bindings.findByInstallationId(installation.id) : null;
  }

  async setBinding(input: {
    workspaceId: string;
    channelId?: string | null;
    answeringAgentId: string;
    escalationChannelId?: string | null;
    gapEscalationEnabled?: boolean;
  }): Promise<SlackChannelBindingRecord> {
    const installation = await this.findInstallationForWorkspace(input.workspaceId);
    if (!installation) {
      throw notFound("Slack installation is not configured");
    }
    return this.options.bindings.upsert({
      installationId: installation.id,
      workspaceId: input.workspaceId,
      channelId: input.channelId ?? null,
      answeringAgentId: input.answeringAgentId,
      escalationChannelId: input.escalationChannelId,
      gapEscalationEnabled: input.gapEscalationEnabled,
    });
  }

  async disconnect(workspaceId: string): Promise<boolean> {
    const installation = await this.findInstallationForWorkspace(workspaceId);
    if (!installation) {
      return false;
    }
    await this.options.bindings.removeByInstallationId(installation.id);
    await this.options.installations.removeByWorkspaceId(installation.workspaceId);
    await this.options.integrationConnections.remove(installation.workspaceId, installation.connectionId, ["slack"]);
    return true;
  }

  async resolveBotTokenForInstallation(installation: SlackInstallationRecord): Promise<string | null> {
    const key = this.requireEncryptionKey();
    const connection = await this.options.integrationConnections.findById(
      installation.workspaceId,
      installation.connectionId,
      ["slack"],
    );
    if (!connection) {
      return null;
    }
    const oauthConnection = await this.options.oauthConnections.findById(
      installation.workspaceId,
      connection.oauthConnectionId,
    );
    if (!oauthConnection?.credentialCiphertext) {
      return null;
    }
    return decryptOauthTokens(oauthConnection.credentialCiphertext, key).accessToken;
  }

  async markNeedsReauthForInstallation(
    installation: SlackInstallationRecord,
    errorCode: string,
  ): Promise<boolean> {
    const updated = await this.options.integrationConnections.update(
      installation.workspaceId,
      installation.connectionId,
      {
        status: "needs_reauth",
        lastHealthStatus: "failed",
        lastHealthCheckedAt: new Date(),
        lastErrorCode: errorCode,
      },
      ["slack"],
    );
    return Boolean(updated);
  }

  private async integrationConnectionForInstallation(
    installation: SlackInstallationRecord,
  ): Promise<IntegrationConnectionRecord> {
    const connection = await this.options.integrationConnections.findById(
      installation.workspaceId,
      installation.connectionId,
      ["slack"],
    );
    if (!connection) {
      throw new Error("Slack installation connection was not found");
    }
    return connection;
  }

  private async createOauthConnection(
    workspaceId: string,
    displayName: string,
    teamId: string,
  ): Promise<OauthConnectionRecord> {
    const input: CreateOauthConnectionInput = {
      workspaceId,
      provider: "slack",
      providerAccountId: teamId,
      displayName,
      status: "pending",
      grantedScopes: [],
    };
    return this.options.oauthConnections.create(input);
  }

  private async writeOauthTokens(
    input: SaveSlackInstallationInput,
    workspaceId: string,
    oauthConnectionId: string,
    encryptionKey: string,
    displayName: string,
  ): Promise<OauthConnectionRecord> {
    const updated = await this.options.oauthConnections.setOauthTokens(
      workspaceId,
      oauthConnectionId,
      encryptOauthTokens(toStoredTokens(input), encryptionKey),
      null,
      input.grantedScopes,
      input.teamId,
    );
    if (!updated) {
      throw new Error(`Slack OAuth connection ${oauthConnectionId} was not found for ${displayName}`);
    }
    return updated;
  }

  private async refreshIntegrationConnection(
    connection: IntegrationConnectionRecord,
    displayName: string,
    oauthConnectionId: string,
  ): Promise<IntegrationConnectionRecord> {
    const updated = await this.options.integrationConnections.update(
      connection.workspaceId,
      connection.id,
      {
        oauthConnectionId,
        displayName,
        status: "authorized",
        lastHealthStatus: "ok",
        lastErrorCode: null,
      },
      ["slack"],
    );
    if (!updated) {
      throw new Error("Slack integration connection was not found");
    }
    return updated;
  }

  private requireEncryptionKey(): string {
    if (!this.options.encryptionKey) {
      throw new Error("CONNECTOR_ENCRYPTION_KEY must be set before saving Slack credentials");
    }
    return this.options.encryptionKey;
  }

  private async requireAccountId(workspaceId: string): Promise<string> {
    const accountId = await this.options.workspaceAccounts.getAccountId(workspaceId);
    if (!accountId) {
      throw notFound("Workspace was not found");
    }
    return accountId;
  }

  private async findInstallationForWorkspace(workspaceId: string): Promise<SlackInstallationRecord | null> {
    const accountId = await this.options.workspaceAccounts.getAccountId(workspaceId);
    return accountId ? this.options.installations.findByAccountId(accountId) : null;
  }
}

interface SlackInstallationRow {
  id: string;
  connection_id: string;
  workspace_id: string;
  account_id: string;
  team_id: string;
  team_name: string | null;
  bot_user_id: string;
  created_at: Date;
  updated_at: Date;
}

const installationColumns = [
  "id",
  "connection_id",
  "workspace_id",
  "account_id",
  "team_id",
  "team_name",
  "bot_user_id",
  "created_at",
  "updated_at",
] as const;

const mapInstallation = (row: SlackInstallationRow): SlackInstallationRecord => ({
  id: row.id,
  connectionId: row.connection_id,
  workspaceId: row.workspace_id,
  accountId: row.account_id,
  teamId: row.team_id,
  teamName: row.team_name,
  botUserId: row.bot_user_id,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class SlackInstallationRepository implements SlackInstallationRepositoryPort {
  constructor(private readonly db: Db) {}

  async findById(installationId: string): Promise<SlackInstallationRecord | null> {
    const row = await this.db
      .selectFrom("slack_installations")
      .select(installationColumns)
      .where("id", "=", installationId)
      .executeTakeFirst();
    return row ? mapInstallation(row as SlackInstallationRow) : null;
  }

  async findByTeamId(teamId: string): Promise<SlackInstallationRecord | null> {
    const row = await this.db
      .selectFrom("slack_installations")
      .select(installationColumns)
      .where("team_id", "=", teamId)
      .executeTakeFirst();
    return row ? mapInstallation(row as SlackInstallationRow) : null;
  }

  async findByWorkspaceId(workspaceId: string): Promise<SlackInstallationRecord | null> {
    const row = await this.db
      .selectFrom("slack_installations")
      .select(installationColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? mapInstallation(row as SlackInstallationRow) : null;
  }

  async findByAccountId(accountId: string): Promise<SlackInstallationRecord | null> {
    const row = await this.db
      .selectFrom("slack_installations")
      .select(installationColumns)
      .where("account_id", "=", accountId)
      .orderBy("updated_at", "desc")
      .orderBy("team_id", "asc")
      .limit(1)
      .executeTakeFirst();
    return row ? mapInstallation(row as SlackInstallationRow) : null;
  }

  async upsert(input: UpsertSlackInstallationInput): Promise<SlackInstallationRecord> {
    const row = await this.db
      .insertInto("slack_installations")
      .values({
        id: randomUUID(),
        connection_id: input.connectionId,
        workspace_id: input.workspaceId,
        account_id: input.accountId,
        team_id: input.teamId,
        team_name: input.teamName ?? null,
        bot_user_id: input.botUserId,
      })
      .onConflict((oc) =>
        oc.column("team_id").doUpdateSet({
          connection_id: (eb) => eb.ref("excluded.connection_id"),
          workspace_id: (eb) => eb.ref("excluded.workspace_id"),
          account_id: (eb) => eb.ref("excluded.account_id"),
          team_name: (eb) => eb.ref("excluded.team_name"),
          bot_user_id: (eb) => eb.ref("excluded.bot_user_id"),
          updated_at: currentTimestamp(),
        }),
      )
      .returning(installationColumns)
      .executeTakeFirstOrThrow();
    return mapInstallation(row as SlackInstallationRow);
  }

  async removeByWorkspaceId(workspaceId: string): Promise<boolean> {
    const rows = await this.db
      .deleteFrom("slack_installations")
      .where("workspace_id", "=", workspaceId)
      .returning("id")
      .execute();
    return rows.length > 0;
  }
}

export class PostgresWorkspaceAccountLookup implements WorkspaceAccountLookup {
  constructor(private readonly db: Db) {}

  async getAccountId(workspaceId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select("account_id")
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    return row?.account_id ?? null;
  }
}

interface SlackChannelBindingRow {
  id: string;
  installation_id: string;
  workspace_id: string;
  channel_id: string | null;
  answering_agent_id: string;
  escalation_channel_id: string | null;
  gap_escalation_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

type SlackBindingDb = Omit<DB, "slack_channel_bindings"> & {
  slack_channel_bindings: DB["slack_channel_bindings"] & {
    gap_escalation_enabled: boolean;
  };
};
type SlackBindingDbExecutor = Kysely<SlackBindingDb> | Transaction<SlackBindingDb>;

const bindingColumns = [
  "id",
  "installation_id",
  "workspace_id",
  "channel_id",
  "answering_agent_id",
  "escalation_channel_id",
  "created_at",
  "updated_at",
] as const;

const mapBinding = (row: SlackChannelBindingRow): SlackChannelBindingRecord => ({
  id: row.id,
  installationId: row.installation_id,
  workspaceId: row.workspace_id,
  channelId: row.channel_id,
  answeringAgentId: row.answering_agent_id,
  escalationChannelId: row.escalation_channel_id,
  gapEscalationEnabled: row.gap_escalation_enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class SlackChannelBindingRepository implements SlackBindingRepositoryPort {
  private readonly db: SlackBindingDbExecutor;

  constructor(db: Db) {
    // Migration 112 owns this column; generated Kysely types are refreshed by the orchestrator.
    this.db = db as unknown as SlackBindingDbExecutor;
  }

  async findByInstallationId(installationId: string): Promise<SlackChannelBindingRecord | null> {
    const row = await this.db
      .selectFrom("slack_channel_bindings")
      .select((eb) => [
        ...bindingColumns,
        eb.ref("gap_escalation_enabled").as("gap_escalation_enabled"),
      ])
      .where("installation_id", "=", installationId)
      .where("channel_id", "is", null)
      .executeTakeFirst();
    return row ? mapBinding(row as SlackChannelBindingRow) : null;
  }

  async findAnswerer(
    installationId: string,
    channelId: string | null,
  ): Promise<SlackChannelBindingRecord | null> {
    if (channelId !== null) {
      const channelRow = await this.db
        .selectFrom("slack_channel_bindings")
        .select((eb) => [
          ...bindingColumns,
          eb.ref("gap_escalation_enabled").as("gap_escalation_enabled"),
        ])
        .where("installation_id", "=", installationId)
        .where("channel_id", "=", channelId)
        .executeTakeFirst();
      if (channelRow) {
        return mapBinding(channelRow as SlackChannelBindingRow);
      }
    }
    // Fall back to the installation default answerer.
    return this.findByInstallationId(installationId);
  }

  async upsert(input: UpsertSlackBindingInput): Promise<SlackChannelBindingRecord> {
    const bindingValues = {
      id: randomUUID(),
      installation_id: input.installationId,
      workspace_id: input.workspaceId,
      channel_id: input.channelId ?? null,
      answering_agent_id: input.answeringAgentId,
      escalation_channel_id: input.escalationChannelId ?? null,
      gap_escalation_enabled: input.gapEscalationEnabled ?? false,
    };
    const row = await this.db
      .insertInto("slack_channel_bindings")
      .values(bindingValues)
      .onConflict((oc) =>
        oc.columns(["installation_id", "channel_id"]).doUpdateSet((eb) => ({
          workspace_id: eb.ref("excluded.workspace_id"),
          answering_agent_id: eb.ref("excluded.answering_agent_id"),
          ...(input.escalationChannelId !== undefined
            ? { escalation_channel_id: eb.ref("excluded.escalation_channel_id") }
            : {}),
          ...(input.gapEscalationEnabled !== undefined
            ? { gap_escalation_enabled: eb.ref("excluded.gap_escalation_enabled") }
            : {}),
          updated_at: currentTimestamp(),
        })),
      )
      .returning((eb) => [
        ...bindingColumns,
        eb.ref("gap_escalation_enabled").as("gap_escalation_enabled"),
      ])
      .executeTakeFirstOrThrow();
    return mapBinding(row as SlackChannelBindingRow);
  }

  async removeByInstallationId(installationId: string): Promise<boolean> {
    const rows = await this.db
      .deleteFrom("slack_channel_bindings")
      .where("installation_id", "=", installationId)
      .returning("id")
      .execute();
    return rows.length > 0;
  }
}
