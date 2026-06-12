import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import {
  applyTestMigration,
  runTestMigrationsBefore,
} from "../support/databaseMigrations.js";

// Regression guard for the 090 routine lineage/lifecycle migration. The bug it pins:
// 090 backfilled duplicate published routines to status 'superseded' BEFORE widening the
// status check constraint (created by 084 as CHECK (status IN ('draft','published'))), so the
// UPDATE violated the still-old constraint and the whole startup migration rolled back — but
// only on databases that actually had >=2 published rows in a lineage. A fresh test database
// has no such rows, so the full-migration suite stayed green while staging crashed on boot.
//
// To reproduce we pin a throwaway database to the pre-090 schema, seed the offending data
// shape, then apply 090 and assert it succeeds. Needs CREATE DATABASE on the integration
// server; skips cleanly when no database is reachable (unit-only CI lanes).
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "090_routine_lineage_lifecycle.sql";

const canCreateIsolatedDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedDatabaseUrl = (baseUrl: string, databaseName: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const hasReachableDatabase = await canCreateIsolatedDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableDatabase ? describe : describe.skip;

describeIfDatabase("routine lineage lifecycle migration (090)", () => {
  const isolatedName = `mig090_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${isolatedName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, isolatedName));
    await runTestMigrationsBefore(database, migrationFile);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    if (admin) {
      await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => undefined);
      await admin.close().catch(() => undefined);
    }
  });

  it("backfills superseded versions when a lineage already has multiple published rows", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await database.execute(
      "INSERT INTO accounts(id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig090-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces(id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents(id, workspace_id, name) VALUES ($1, $2, 'Agent')",
      [agentId, workspaceId],
    );

    // Two published rows for the same agent+name — the data shape that tripped the constraint.
    for (const version of [1, 2]) {
      await database.execute(
        `INSERT INTO routine_definition(id, agent_id, version, name, status, activation_trigger_description)
         VALUES ($1, $2, $3, 'callback-request', 'published', 'When the user asks to be called back')`,
        [randomUUID(), agentId, version],
      );
    }

    await expect(applyTestMigration(database, migrationFile)).resolves.not.toThrow();

    const rows = await database.query<{ version: number; status: string; lineage_id: string }>(
      "SELECT version, status, lineage_id FROM routine_definition ORDER BY version",
    );

    expect(rows.map((row) => ({ version: row.version, status: row.status }))).toEqual([
      { version: 1, status: "superseded" },
      { version: 2, status: "published" },
    ]);
    // Same agent+name collapses into one lineage.
    expect(new Set(rows.map((row) => row.lineage_id)).size).toBe(1);

    const [constraint] = await database.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'routine_definition_status_check'",
    );
    expect(constraint.def).toContain("superseded");
    expect(constraint.def).toContain("archived");
  });
});
