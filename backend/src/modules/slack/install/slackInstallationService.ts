import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { notFound } from "../../../shared/domain/errors.js";
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

export interface SlackInstallationRecord {
  id: string;
  connectionId: string;
  workspaceId: string;
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
  answeringAgentId: string;
  escalationChannelId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertSlackInstallationInput {
  connectionId: string;
  workspaceId: string;
  teamId: string;
  teamName?: string | null;
  botUserId: string;
}

export interface UpsertSlackBindingInput {
  installationId: string;
  workspaceId: string;
  answeringAgentId: string;
  escalationChannelId?: string | null;
}

export interface SlackInstallationRepositoryPort {
  findByTeamId(teamId: string): Promise<SlackInstallationRecord | null>;
  findByWorkspaceId(workspaceId: string): Promise<SlackInstallationRecord | null>;
  upsert(input: UpsertSlackInstallationInput): Promise<SlackInstallationRecord>;
  removeByWorkspaceId(workspaceId: string): Promise<boolean>;
}

export interface SlackBindingRepositoryPort {
  findByInstallationId(installationId: string): Promise<SlackChannelBindingRecord | null>;
  upsert(input: UpsertSlackBindingInput): Promise<SlackChannelBindingRecord>;
  removeByInstallationId(installationId: string): Promise<boolean>;
}

export interface SlackInstallationServiceOptions {
  oauthConnections: Pick<OauthConnectionRepositoryPort, "create" | "findById" | "setOauthTokens">;
  integrationConnections: Pick<IntegrationConnectionRepositoryPort, "create" | "findById" | "update" | "remove">;
  installations: SlackInstallationRepositoryPort;
  bindings: SlackBindingRepositoryPort;
  encryptionKey?: string;
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
}

export interface SaveSlackInstallationResult {
  oauthConnection: OauthConnectionRecord;
  connection: IntegrationConnectionRecord;
  installation: SlackInstallationRecord;
  binding: SlackChannelBindingRecord | null;
}

export interface SlackInstallationStatus {
  status: "connected" | "needs_reauth" | "disabled" | "not_configured";
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

export class SlackInstallationService {
  constructor(private readonly options: SlackInstallationServiceOptions) {}

  async saveInstallation(input: SaveSlackInstallationInput): Promise<SaveSlackInstallationResult> {
    const key = this.requireEncryptionKey();
    const existingInstallation = await this.options.installations.findByTeamId(input.teamId);
    const displayName = displayNameForTeam(input.teamName, input.teamId);

    const oauthConnectionId = existingInstallation
      ? await this.oauthConnectionIdForInstallation(existingInstallation)
      : input.oauthConnectionId ?? (await this.createOauthConnection(input.workspaceId, displayName, input.teamId)).id;

    const oauthConnection = await this.writeOauthTokens(input, oauthConnectionId, key, displayName);
    const connection = existingInstallation
      ? await this.refreshIntegrationConnection(existingInstallation, displayName)
      : await this.options.integrationConnections.create({
          workspaceId: input.workspaceId,
          oauthConnectionId: oauthConnection.id,
          provider: "slack",
          displayName,
          status: "authorized",
          config: {},
        });

    const installation = await this.options.installations.upsert({
      connectionId: connection.id,
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      teamName: input.teamName ?? null,
      botUserId: input.botUserId,
    });
    const binding = input.answeringAgentId
      ? await this.options.bindings.upsert({
          installationId: installation.id,
          workspaceId: input.workspaceId,
          answeringAgentId: input.answeringAgentId,
          escalationChannelId: input.escalationChannelId ?? null,
        })
      : await this.options.bindings.findByInstallationId(installation.id);

    return { oauthConnection, connection, installation, binding };
  }

  async getStatus(workspaceId: string): Promise<SlackInstallationStatus> {
    const installation = await this.options.installations.findByWorkspaceId(workspaceId);
    if (!installation) {
      return { status: "not_configured" };
    }
    const connection = await this.options.integrationConnections.findById(workspaceId, installation.connectionId, ["slack"]);
    if (!connection) {
      return { status: "not_configured" };
    }
    const binding = await this.options.bindings.findByInstallationId(installation.id);
    return {
      status: connection.status === "authorized"
        ? "connected"
        : connection.status === "error"
          ? "needs_reauth"
          : connection.status,
      ...(installation.teamName ? { teamName: installation.teamName } : {}),
      ...(binding?.answeringAgentId ? { answeringAgentId: binding.answeringAgentId } : {}),
    };
  }

  async getBinding(workspaceId: string): Promise<SlackChannelBindingRecord | null> {
    const installation = await this.options.installations.findByWorkspaceId(workspaceId);
    return installation ? this.options.bindings.findByInstallationId(installation.id) : null;
  }

  async setBinding(input: {
    workspaceId: string;
    answeringAgentId: string;
    escalationChannelId?: string | null;
  }): Promise<SlackChannelBindingRecord> {
    const installation = await this.options.installations.findByWorkspaceId(input.workspaceId);
    if (!installation) {
      throw notFound("Slack installation is not configured");
    }
    return this.options.bindings.upsert({
      installationId: installation.id,
      workspaceId: input.workspaceId,
      answeringAgentId: input.answeringAgentId,
      escalationChannelId: input.escalationChannelId ?? null,
    });
  }

  async disconnect(workspaceId: string): Promise<boolean> {
    const installation = await this.options.installations.findByWorkspaceId(workspaceId);
    if (!installation) {
      return false;
    }
    await this.options.bindings.removeByInstallationId(installation.id);
    await this.options.installations.removeByWorkspaceId(workspaceId);
    await this.options.integrationConnections.remove(workspaceId, installation.connectionId, ["slack"]);
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

  private async oauthConnectionIdForInstallation(installation: SlackInstallationRecord): Promise<string> {
    const connection = await this.options.integrationConnections.findById(
      installation.workspaceId,
      installation.connectionId,
      ["slack"],
    );
    if (!connection) {
      throw new Error("Slack installation connection was not found");
    }
    return connection.oauthConnectionId;
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
    oauthConnectionId: string,
    encryptionKey: string,
    displayName: string,
  ): Promise<OauthConnectionRecord> {
    const updated = await this.options.oauthConnections.setOauthTokens(
      input.workspaceId,
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
    installation: SlackInstallationRecord,
    displayName: string,
  ): Promise<IntegrationConnectionRecord> {
    const updated = await this.options.integrationConnections.update(
      installation.workspaceId,
      installation.connectionId,
      {
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
}

interface SlackInstallationRow extends QueryResultRow {
  id: string;
  connection_id: string;
  workspace_id: string;
  team_id: string;
  team_name: string | null;
  bot_user_id: string;
  created_at: Date;
  updated_at: Date;
}

const installationColumns = "id, connection_id, workspace_id, team_id, team_name, bot_user_id, created_at, updated_at";

const mapInstallation = (row: SlackInstallationRow): SlackInstallationRecord => ({
  id: row.id,
  connectionId: row.connection_id,
  workspaceId: row.workspace_id,
  teamId: row.team_id,
  teamName: row.team_name,
  botUserId: row.bot_user_id,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class SlackInstallationRepository implements SlackInstallationRepositoryPort {
  constructor(private readonly database: { query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<T[]> }) {}

  async findByTeamId(teamId: string): Promise<SlackInstallationRecord | null> {
    const [row] = await this.database.query<SlackInstallationRow>(
      `SELECT ${installationColumns} FROM slack_installations WHERE team_id = $1`,
      [teamId],
    );
    return row ? mapInstallation(row) : null;
  }

  async findByWorkspaceId(workspaceId: string): Promise<SlackInstallationRecord | null> {
    const [row] = await this.database.query<SlackInstallationRow>(
      `SELECT ${installationColumns}
       FROM slack_installations
       WHERE workspace_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [workspaceId],
    );
    return row ? mapInstallation(row) : null;
  }

  async upsert(input: UpsertSlackInstallationInput): Promise<SlackInstallationRecord> {
    const [row] = await this.database.query<SlackInstallationRow>(
      `INSERT INTO slack_installations
         (id, connection_id, workspace_id, team_id, team_name, bot_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (team_id) DO UPDATE
       SET connection_id = EXCLUDED.connection_id,
           workspace_id = EXCLUDED.workspace_id,
           team_name = EXCLUDED.team_name,
           bot_user_id = EXCLUDED.bot_user_id,
           updated_at = NOW()
       RETURNING ${installationColumns}`,
      [randomUUID(), input.connectionId, input.workspaceId, input.teamId, input.teamName ?? null, input.botUserId],
    );
    return mapInstallation(row);
  }

  async removeByWorkspaceId(workspaceId: string): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(
      `DELETE FROM slack_installations WHERE workspace_id = $1 RETURNING id`,
      [workspaceId],
    );
    return rows.length > 0;
  }
}

interface SlackChannelBindingRow extends QueryResultRow {
  id: string;
  installation_id: string;
  workspace_id: string;
  answering_agent_id: string;
  escalation_channel_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const bindingColumns = "id, installation_id, workspace_id, answering_agent_id, escalation_channel_id, created_at, updated_at";

const mapBinding = (row: SlackChannelBindingRow): SlackChannelBindingRecord => ({
  id: row.id,
  installationId: row.installation_id,
  workspaceId: row.workspace_id,
  answeringAgentId: row.answering_agent_id,
  escalationChannelId: row.escalation_channel_id,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class SlackChannelBindingRepository implements SlackBindingRepositoryPort {
  constructor(private readonly database: { query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<T[]> }) {}

  async findByInstallationId(installationId: string): Promise<SlackChannelBindingRecord | null> {
    const [row] = await this.database.query<SlackChannelBindingRow>(
      `SELECT ${bindingColumns}
       FROM slack_channel_bindings
       WHERE installation_id = $1`,
      [installationId],
    );
    return row ? mapBinding(row) : null;
  }

  async upsert(input: UpsertSlackBindingInput): Promise<SlackChannelBindingRecord> {
    const [row] = await this.database.query<SlackChannelBindingRow>(
      `INSERT INTO slack_channel_bindings
         (id, installation_id, workspace_id, answering_agent_id, escalation_channel_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (installation_id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id,
           answering_agent_id = EXCLUDED.answering_agent_id,
           escalation_channel_id = EXCLUDED.escalation_channel_id,
           updated_at = NOW()
       RETURNING ${bindingColumns}`,
      [
        randomUUID(),
        input.installationId,
        input.workspaceId,
        input.answeringAgentId,
        input.escalationChannelId ?? null,
      ],
    );
    return mapBinding(row);
  }

  async removeByInstallationId(installationId: string): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(
      `DELETE FROM slack_channel_bindings WHERE installation_id = $1 RETURNING id`,
      [installationId],
    );
    return rows.length > 0;
  }
}
