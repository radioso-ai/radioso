import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runAllTestMigrations, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "160_machine_access.sql";

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedUrl = (base: string, name: string): string => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("machine-access migration (160)", () => {
  const databaseName = `mig160_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, migrationFile);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("destroys legacy authenticating material and retains only a safe tombstone", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const tokenId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Migration', $2, 'hash')",
      [accountId, `migration-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Workspace', $3)",
      [workspaceId, accountId, `migration-${workspaceId}`],
    );
    await database.execute(
      `INSERT INTO workspace_tokens
        (id, workspace_id, account_id, token_prefix, token_hash, encrypted_token)
       VALUES ($1, $2, $3, 'radioso_dead', 'legacy-verifier', 'legacy-ciphertext')`,
      [tokenId, workspaceId, accountId],
    );

    await database.execute("CREATE VIEW migration_157_drop_blocker AS SELECT id FROM workspace_tokens");
    await expect(applyTestMigration(database, migrationFile)).rejects.toThrow();
    expect(await database.queryOne<{ token_hash: string; encrypted_token: string }>(
      "SELECT token_hash, encrypted_token FROM workspace_tokens WHERE id = $1",
      [tokenId],
    )).toEqual({ token_hash: "legacy-verifier", encrypted_token: "legacy-ciphertext" });
    const [rolledBackTable] = await database.query<{ table_name: string | null }>(
      "SELECT to_regclass('api_credentials')::text AS table_name",
    );
    expect(rolledBackTable?.table_name).toBeNull();
    await database.execute("DROP VIEW migration_157_drop_blocker");

    await applyTestMigration(database, migrationFile);

    const [legacyTable] = await database.query<{ table_name: string | null }>(
      "SELECT to_regclass('workspace_tokens')::text AS table_name",
    );
    expect(legacyTable?.table_name).toBeNull();

    const [tombstone] = await database.query<{
      legacy_token_id: string;
      workspace_id: string;
      account_id: string;
      token_prefix: string;
      final_status: string;
      system_reason: string;
    }>("SELECT * FROM legacy_workspace_credential_tombstones WHERE legacy_token_id = $1", [tokenId]);
    expect(tombstone).toMatchObject({
      legacy_token_id: tokenId,
      workspace_id: workspaceId,
      account_id: accountId,
      token_prefix: "radioso_dead",
      final_status: "destroyed",
      system_reason: "legacy_workspace_credential_destroyed",
    });
    expect(tombstone).not.toHaveProperty("token_hash");
    expect(tombstone).not.toHaveProperty("encrypted_token");

    const [migrationAudit] = await database.query<{
      event_type: string;
      metadata_json: Record<string, unknown>;
    }>("SELECT event_type, metadata_json FROM audit_events WHERE event_type = 'machine_access.legacy_workspace_credential.destroyed'");
    expect(migrationAudit).toMatchObject({
      event_type: "machine_access.legacy_workspace_credential.destroyed",
      metadata_json: {
        legacyTokenId: tokenId,
        tokenPrefix: "radioso_dead",
        reason: "legacy_workspace_credential_destroyed",
        systemInitiated: true,
      },
    });
    expect(JSON.stringify(migrationAudit?.metadata_json)).not.toContain("legacy-verifier");
    expect(JSON.stringify(migrationAudit?.metadata_json)).not.toContain("legacy-ciphertext");

    await expect(applyTestMigration(database, migrationFile)).resolves.toBeUndefined();
    const [count] = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM legacy_workspace_credential_tombstones WHERE legacy_token_id = $1",
      [tokenId],
    );
    expect(count?.count).toBe("1");
    const [auditCount] = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM audit_events WHERE event_type = 'machine_access.legacy_workspace_credential.destroyed'",
    );
    expect(auditCount?.count).toBe("1");
  });

  it("creates hash-only personal/service credential storage and warning claims", async () => {
    const columns = await database.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('api_credentials', 'workspace_service_accounts', 'api_credential_expiry_warnings')`,
    );
    const credentialColumns = columns
      .filter((column) => column.table_name === "api_credentials")
      .map((column) => column.column_name);
    expect(credentialColumns).toContain("token_hash");
    expect(credentialColumns).not.toContain("encrypted_token");
    expect(columns.some((column) => column.table_name === "workspace_service_accounts")).toBe(true);
    expect(columns.some((column) => column.table_name === "api_credential_expiry_warnings")).toBe(true);
    expect(columns.filter((column) => column.column_name === "created_by_user_id"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table_name: "api_credentials", is_nullable: "NO" }),
        expect.objectContaining({ table_name: "workspace_service_accounts", is_nullable: "NO" }),
      ]));
  });

  it("rejects service identities and credentials whose account does not own the workspace", async () => {
    const firstAccountId = randomUUID();
    const secondAccountId = randomUUID();
    const workspaceId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'First', $2, 'hash'), ($3, 'Second', $4, 'hash')",
      [
        firstAccountId,
        `first-${firstAccountId}@example.com`,
        secondAccountId,
        `second-${secondAccountId}@example.com`,
      ],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Workspace', $3)",
      [workspaceId, firstAccountId, `workspace-${workspaceId}`],
    );

    await expect(database.execute(
      `INSERT INTO workspace_service_accounts
        (id, workspace_id, account_id, display_name, role)
       VALUES ($1, $2, $3, 'Invalid', 'member')`,
      [randomUUID(), workspaceId, secondAccountId],
    )).rejects.toThrow();
  });
});

describeIfDatabase("machine-access migration parity", () => {
  const freshDatabaseName = `mig_fresh_${randomUUID().replaceAll("-", "")}`;
  const upgradeDatabaseName = `mig_upgrade_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let freshDatabase: Database;
  let upgradeDatabase: Database;

  const seedOriginMainState = async (database: Database, expiresAt: string | null = null) => {
    const accountId = randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const proposalId = randomUUID();
    const grantId = randomUUID();
    const tokenPrefix = "rdso_legacy_mcp";

    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Parity', $2, 'hash')",
      [accountId, `parity-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')",
      [userId, `parity-user-${userId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Parity', $3)",
      [workspaceId, accountId, `parity-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Parity agent')",
      [agentId, workspaceId],
    );
    await database.execute(
      "INSERT INTO copilot_conversations (id, workspace_id, operator_user_id) VALUES ($1, $2, $3)",
      [conversationId, workspaceId, userId],
    );
    await database.execute(
      `INSERT INTO copilot_proposals
        (id, workspace_id, operator_user_id, conversation_id, target_type, target_ref, payload, version_token)
       VALUES ($1, $2, $3, $4, 'agent', '{}'::jsonb, '{}'::jsonb, 'origin-main-agent')`,
      [proposalId, workspaceId, userId, conversationId],
    );
    await database.execute(
      `INSERT INTO agent_access_grants
        (id, agent_id, workspace_id, label, principal_kind, role, channel, token_prefix, token_hash,
         encrypted_token, origin_mode, origin_allowlist, expires_at)
       VALUES ($1, $2, $3, NULL, 'agent-api', 'agent', 'mcp-converse', $4, $5,
               'legacy-ciphertext', 'allow-all', ARRAY[]::text[], $6)`,
      [grantId, agentId, workspaceId, tokenPrefix, `hash-${grantId}`, expiresAt],
    );

    return { proposalId, grantId, tokenPrefix };
  };

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${freshDatabaseName}"`);
    await admin.execute(`CREATE DATABASE "${upgradeDatabaseName}"`);
    freshDatabase = new Database(isolatedUrl(integrationDatabaseUrl!, freshDatabaseName));
    upgradeDatabase = new Database(isolatedUrl(integrationDatabaseUrl!, upgradeDatabaseName));
  });

  afterAll(async () => {
    await freshDatabase?.close().catch(() => undefined);
    await upgradeDatabase?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${freshDatabaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${upgradeDatabaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("keeps agent copilot proposals valid on a fresh schema", async () => {
    await runAllTestMigrations(freshDatabase);
    const state = await seedOriginMainState(freshDatabase, "2100-01-01T00:00:00Z");

    const [proposal] = await freshDatabase.query<{ target_type: string }>(
      "SELECT target_type FROM copilot_proposals WHERE id = $1",
      [state.proposalId],
    );
    expect(proposal).toEqual({ target_type: "agent" });
  });

  it("preserves origin/main agent proposals and backfills legacy MCP labels during upgrade", async () => {
    await runTestMigrationsBefore(upgradeDatabase, migrationFile);
    const state = await seedOriginMainState(upgradeDatabase);

    await applyTestMigration(upgradeDatabase, "160_machine_access.sql");
    await applyTestMigration(upgradeDatabase, "161_api_credentials_optional_expiry.sql");
    await applyTestMigration(upgradeDatabase, "162_agent_channel_credentials.sql");

    const [proposal] = await upgradeDatabase.query<{ target_type: string }>(
      "SELECT target_type FROM copilot_proposals WHERE id = $1",
      [state.proposalId],
    );
    expect(proposal).toEqual({ target_type: "agent" });

    const [grant] = await upgradeDatabase.query<{
      label: string;
      principal_kind: string;
      encrypted_token: string | null;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>("SELECT label, principal_kind, encrypted_token, expires_at, revoked_at FROM agent_access_grants WHERE id = $1", [state.grantId]);
    expect(grant).toEqual({
      label: `MCP credential ${state.tokenPrefix}`,
      principal_kind: "agent-api",
      encrypted_token: null,
      expires_at: expect.any(Date),
      revoked_at: expect.any(Date),
    });
  });
});
