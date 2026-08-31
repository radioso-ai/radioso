import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "158_machine_access.sql";

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

describeIfDatabase("machine-access migration (158)", () => {
  const databaseName = `mig158_${randomUUID().replaceAll("-", "")}`;
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
