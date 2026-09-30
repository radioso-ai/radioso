import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresWorkspaceMemberLookup } from "../../src/modules/slack/operator/workspaceMemberLookup.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// A Slack actor must resolve to their own Radioso user, so their takeover is attributed to them
// and not to whoever owns the organisation.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("PostgresWorkspaceMemberLookup (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const lookup = new PostgresWorkspaceMemberLookup(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const disabledId = randomUUID();
  const ownerEmail = `slack-owner-${ownerId}@example.com`;
  const memberEmail = `slack-member-${memberId}@example.com`;
  const disabledEmail = `slack-disabled-${disabledId}@example.com`;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Slack Lookup Co", ownerEmail, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Support", `slack-lookup-${workspaceId}`],
    );
    for (const [id, email] of [[ownerId, ownerEmail], [memberId, memberEmail], [disabledId, disabledEmail]]) {
      await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [id, email, "hash"]);
    }
    await database.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [disabledId]);
    for (const [id, role] of [[ownerId, "owner"], [memberId, "member"], [disabledId, "member"]]) {
      await database.query(
        `INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, $4, 'active')`,
        [randomUUID(), accountId, id, role],
      );
    }
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ownerId, memberId, disabledId]]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("resolves a member to their own user, not to the organisation's owner", async () => {
    await expect(lookup.findByEmail(workspaceId, memberEmail.toUpperCase())).resolves.toEqual({ accountId, userId: memberId });
    await expect(lookup.findByEmail(workspaceId, ownerEmail)).resolves.toEqual({ accountId, userId: ownerId });
  });

  it("finds nobody for a disabled user or an unknown address", async () => {
    await expect(lookup.findByEmail(workspaceId, disabledEmail)).resolves.toBeNull();
    await expect(lookup.findByEmail(workspaceId, `nobody-${randomUUID()}@example.com`)).resolves.toBeNull();
  });

  it("finds nobody for a workspace the member's organisation cannot reach", async () => {
    await expect(lookup.findByEmail(randomUUID(), memberEmail)).resolves.toBeNull();
  });
});
