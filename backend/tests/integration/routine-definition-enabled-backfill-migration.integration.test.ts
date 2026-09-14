import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import {
  applyTestMigration,
  runTestMigrationsBefore,
} from "../support/databaseMigrations.js";

// Regression guard for the 181 routine-definition-enabled backfill. The bug it pins: the
// migration only disabled a lineage whose canonical (highest-version) row was
// status='archived', leaving a canonical row that is status='draft' — an "Edit revision"
// started before this collapse and never finished publishing — at the column default
// enabled=TRUE. After this branch deploys, that unfinished draft becomes the one live
// definition for its lineage instead of staying parked, exactly the shape a shared staging
// workspace already has (v1 superseded, v2 published, v3 draft-canonical).
//
// Needs CREATE DATABASE on the integration server; skips cleanly when no database is reachable
// (unit-only CI lanes).
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "181_routine_definition_enabled.sql";

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

describeIfDatabase("routine definition enabled backfill migration (181)", () => {
  const isolatedName = `mig181_${randomUUID().replace(/-/g, "")}`;
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

  it("disables a draft-canonical row left live on top of a published history, and leaves a published-canonical lineage enabled", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const draftCanonicalLineageId = randomUUID();
    const publishedCanonicalLineageId = randomUUID();

    await database.execute(
      "INSERT INTO accounts(id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig181-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces(id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents(id, workspace_id, name) VALUES ($1, $2, 'Agent')",
      [agentId, workspaceId],
    );

    // v1 superseded, v2 published, v3 draft — an "Edit revision" started pre-cutover and never
    // finished — is the canonical (highest-version) row. It must backfill disabled even though
    // its own status is 'draft', not 'archived'.
    const draftCanonicalRows: Array<{ version: number; status: string }> = [
      { version: 1, status: "superseded" },
      { version: 2, status: "published" },
      { version: 3, status: "draft" },
    ];
    for (const row of draftCanonicalRows) {
      await database.execute(
        `INSERT INTO routine_definition(id, agent_id, lineage_id, version, name, status, activation_trigger_description)
         VALUES ($1, $2, $3, $4, 'callback-request', $5, 'When the user asks to be called back')`,
        [randomUUID(), agentId, draftCanonicalLineageId, row.version, row.status],
      );
    }

    // A lineage whose canonical row is ordinarily published must stay enabled.
    await database.execute(
      `INSERT INTO routine_definition(id, agent_id, lineage_id, version, name, status, activation_trigger_description)
       VALUES ($1, $2, $3, 1, 'schedule-visit', 'published', 'When the user asks to schedule a visit')`,
      [randomUUID(), agentId, publishedCanonicalLineageId],
    );

    await expect(applyTestMigration(database, migrationFile)).resolves.not.toThrow();

    const draftCanonicalBackfilled = await database.query<{ version: number; status: string; enabled: boolean }>(
      "SELECT version, status, enabled FROM routine_definition WHERE lineage_id = $1 ORDER BY version",
      [draftCanonicalLineageId],
    );
    expect(draftCanonicalBackfilled).toEqual([
      expect.objectContaining({ version: 1, status: "superseded", enabled: true }),
      expect.objectContaining({ version: 2, status: "published", enabled: true }),
      expect.objectContaining({ version: 3, status: "draft", enabled: false }),
    ]);

    const [publishedCanonicalRow] = await database.query<{ enabled: boolean }>(
      "SELECT enabled FROM routine_definition WHERE lineage_id = $1",
      [publishedCanonicalLineageId],
    );
    expect(publishedCanonicalRow.enabled).toBe(true);
  });
});
