import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { SlackOperatorIdentityRepository } from "../../../src/modules/slack/persistence/slackOperatorIdentityRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

// Real-Postgres characterization of SlackOperatorIdentityRepository after the Kysely rewrite:
// the (installation_id, slack_user_id) upsert conflict target, display-name refresh, and
// DB-clock timestamps are the spec the builder must preserve.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("SlackOperatorIdentityRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new SlackOperatorIdentityRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const oauthConnectionId = randomUUID();
  const connectionId = randomUUID();
  const installationId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Op Co",
      `op-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Op Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, 'slack', 'Slack', 'authorized', ARRAY['chat:write'])`,
      [oauthConnectionId, workspaceId],
    );
    await database.query(
      `INSERT INTO integration_connections (id, workspace_id, oauth_connection_id, provider, display_name, status, config)
       VALUES ($1, $2, $3, 'slack', 'Slack', 'authorized', '{}'::jsonb)`,
      [connectionId, workspaceId, oauthConnectionId],
    );
    await database.query(
      `INSERT INTO slack_installations (id, connection_id, workspace_id, team_id, bot_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [installationId, connectionId, workspaceId, `T-${installationId}`, "UBOT"],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("returns null when no identity is linked", async () => {
    expect(await repository.findByInstallationAndSlackUser({ installationId, slackUserId: "U404" })).toBeNull();
  });

  it("upserts an identity then refreshes display name on (installation, slack_user) conflict", async () => {
    const created = await repository.upsert({
      workspaceId,
      installationId,
      slackUserId: "U1",
      accountId,
      slackDisplayName: "Dana",
    });
    expect(created).toMatchObject({
      workspaceId,
      installationId,
      slackUserId: "U1",
      accountId,
      slackDisplayName: "Dana",
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);

    const found = await repository.findByInstallationAndSlackUser({ installationId, slackUserId: "U1" });
    expect(found?.id).toBe(created.id);

    const updated = await repository.upsert({
      workspaceId,
      installationId,
      slackUserId: "U1",
      accountId,
      slackDisplayName: "Dana S.",
    });
    // Same row (the (installation_id, slack_user_id) conflict target), display name refreshed.
    expect(updated.id).toBe(created.id);
    expect(updated.slackDisplayName).toBe("Dana S.");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });
});
