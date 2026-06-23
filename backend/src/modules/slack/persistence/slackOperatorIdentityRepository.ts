import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

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

const identityColumns = [
  "id",
  "workspace_id",
  "installation_id",
  "slack_user_id",
  "account_id",
  "slack_display_name",
  "created_at",
  "updated_at",
] as const;

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
  constructor(private readonly db: Db) {}

  async findByInstallationAndSlackUser(input: {
    installationId: string;
    slackUserId: string;
  }): Promise<SlackOperatorIdentityRecord | null> {
    const row = await this.db
      .selectFrom("slack_operator_identities")
      .select(identityColumns)
      .where("installation_id", "=", input.installationId)
      .where("slack_user_id", "=", input.slackUserId)
      .executeTakeFirst();
    return row ? mapIdentity(row) : null;
  }

  async upsert(input: {
    workspaceId: string;
    installationId: string;
    slackUserId: string;
    accountId: string;
    slackDisplayName?: string | null;
  }): Promise<SlackOperatorIdentityRecord> {
    const row = await this.db
      .insertInto("slack_operator_identities")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        installation_id: input.installationId,
        slack_user_id: input.slackUserId,
        account_id: input.accountId,
        slack_display_name: input.slackDisplayName ?? null,
      })
      .onConflict((oc) =>
        oc.columns(["installation_id", "slack_user_id"]).doUpdateSet({
          workspace_id: input.workspaceId,
          account_id: input.accountId,
          slack_display_name: input.slackDisplayName ?? null,
          updated_at: currentTimestamp(),
        }),
      )
      .returning(identityColumns)
      .executeTakeFirstOrThrow();
    return mapIdentity(row);
  }
}
