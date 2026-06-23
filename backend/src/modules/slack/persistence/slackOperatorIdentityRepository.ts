import { randomUUID } from "node:crypto";

import type { DatabaseExecutor } from "../../../shared/infra/database.js";

export interface SlackOperatorIdentityRecord {
  id: string;
  workspaceId: string;
  installationId: string;
  slackUserId: string;
  accountId: string;
  slackDisplayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SlackOperatorIdentityRepositoryPort {
  findByInstallationAndSlackUser(input: {
    installationId: string;
    slackUserId: string;
  }): Promise<SlackOperatorIdentityRecord | null>;
  upsert(input: {
    workspaceId: string;
    installationId: string;
    slackUserId: string;
    accountId: string;
    slackDisplayName?: string | null;
  }): Promise<SlackOperatorIdentityRecord>;
}

interface SlackOperatorIdentityRow {
  id: string;
  workspace_id: string;
  installation_id: string;
  slack_user_id: string;
  account_id: string;
  slack_display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapIdentity = (row: SlackOperatorIdentityRow): SlackOperatorIdentityRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  installationId: row.installation_id,
  slackUserId: row.slack_user_id,
  accountId: row.account_id,
  slackDisplayName: row.slack_display_name ?? null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class SlackOperatorIdentityRepository implements SlackOperatorIdentityRepositoryPort {
  constructor(private readonly database: DatabaseExecutor) {}

  async findByInstallationAndSlackUser(input: {
    installationId: string;
    slackUserId: string;
  }): Promise<SlackOperatorIdentityRecord | null> {
    const row = await this.database.queryOptional<SlackOperatorIdentityRow>(
      `SELECT id, workspace_id, installation_id, slack_user_id, account_id, slack_display_name, created_at, updated_at
       FROM slack_operator_identities
       WHERE installation_id = $1 AND slack_user_id = $2`,
      [input.installationId, input.slackUserId],
    );
    return row ? mapIdentity(row) : null;
  }

  async upsert(input: {
    workspaceId: string;
    installationId: string;
    slackUserId: string;
    accountId: string;
    slackDisplayName?: string | null;
  }): Promise<SlackOperatorIdentityRecord> {
    const row = await this.database.queryOne<SlackOperatorIdentityRow>(
      `INSERT INTO slack_operator_identities (
         id, workspace_id, installation_id, slack_user_id, account_id, slack_display_name
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (installation_id, slack_user_id)
       DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         account_id = EXCLUDED.account_id,
         slack_display_name = EXCLUDED.slack_display_name,
         updated_at = NOW()
       RETURNING id, workspace_id, installation_id, slack_user_id, account_id, slack_display_name, created_at, updated_at`,
      [
        randomUUID(),
        input.workspaceId,
        input.installationId,
        input.slackUserId,
        input.accountId,
        input.slackDisplayName ?? null,
      ],
    );
    return mapIdentity(row);
  }
}
