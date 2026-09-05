import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const fieldGuardMigration = "107_routine_field_guards.sql";
const topicCensusRepairMigration = "156_repair_topic_census_workspace_scope.sql";
const topicTransitionUniquenessMigration = "166_topic_transitions_run_topic_unique.sql";

const canCreateIsolatedDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) return false;
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

describeIfDatabase("routine field guard migration re-runs", () => {
  const isolatedName = `mig107_rerun_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${isolatedName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, isolatedName));
    await runTestMigrationsBefore(database, fieldGuardMigration);
    await applyTestMigration(database, fieldGuardMigration);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    if (admin) {
      await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}"`);
      await admin.close().catch(() => undefined);
    }
  });

  it("preserves field transitions when earlier guard migrations are replayed", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const definitionId = randomUUID();

    await database.execute(
      "INSERT INTO accounts(id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig107-rerun-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces(id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents(id, workspace_id, name) VALUES ($1, $2, 'Agent')",
      [agentId, workspaceId],
    );
    await database.execute(
      `INSERT INTO routine_definition(
         id, agent_id, lineage_id, version, name, status, activation_trigger_description
       ) VALUES ($1, $2, $1, 1, 'field-guard-rerun', 'published', 'Exercise migration re-runs')`,
      [definitionId, agentId],
    );
    await database.execute(
      `INSERT INTO routine_transition(
         definition_id, from_step, to_ref, guard_kind, field_ref, field_op, field_value, ordinal
       ) VALUES ($1, 'start', 'complete', 'field', 'slot:plan', 'equals', $2::jsonb, 0)`,
      [definitionId, JSON.stringify("premium")],
    );

    await expect(applyTestMigration(database, "085_structured_routine_guards.sql")).resolves.not.toThrow();
    await expect(applyTestMigration(database, "089_routine_default_guard_schema_cut.sql")).resolves.not.toThrow();

    const [transition] = await database.query<{ guard_kind: string; field_ref: string }>(
      "SELECT guard_kind, field_ref FROM routine_transition WHERE definition_id = $1",
      [definitionId],
    );
    expect(transition).toEqual({ guard_kind: "field", field_ref: "slot:plan" });

    const [constraint] = await database.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'routine_transition'::regclass
         AND conname = 'routine_transition_guard_kind_check'`,
    );
    expect(constraint.definition).toContain("field");
  });
});

describeIfDatabase("topic census workspace-scope repair migration", () => {
  const isolatedName = `mig156_repair_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${isolatedName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, isolatedName));
    await runTestMigrationsBefore(database, "138_topic_transition_centroid_fallback.sql");
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    if (admin) {
      await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}"`);
      await admin.close().catch(() => undefined);
    }
  });

  it("restores tenant columns and constraints on legacy census tables", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const runId = randomUUID();
    const topicId = randomUUID();

    await database.execute(
      "INSERT INTO accounts(id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig137-rerun-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces(id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO conversations(id, workspace_id) VALUES ($1, $2)",
      [conversationId, workspaceId],
    );
    await database.execute(
      `INSERT INTO messages(id, conversation_id, role, content, workspace_id)
       VALUES ($1, $2, 'user', 'Question', $3)`,
      [messageId, conversationId, workspaceId],
    );
    await database.execute(
      `INSERT INTO topic_census_runs(
         id, workspace_id, window_start, window_end, question_count, seed, params_json
       ) VALUES ($1, $2, now() - interval '1 day', now(), 1, 'seed', '{}'::jsonb)`,
      [runId, workspaceId],
    );
    await database.execute(
      `INSERT INTO topics(
         id, workspace_id, centroid, dimensions, radius, title, description,
         created_run_id, last_seen_run_id
       ) VALUES ($1, $2, '[1,0,0]'::vector, 3, 0.1, 'Topic', 'Description', $3, $3)`,
      [topicId, workspaceId, runId],
    );
    await database.execute(
      `INSERT INTO topic_memberships(workspace_id, run_id, topic_id, message_id, distance)
       VALUES ($1, $2, $3, $4, 0.1)`,
      [workspaceId, runId, topicId, messageId],
    );
    await database.execute(
      `INSERT INTO topic_transitions(workspace_id, run_id, topic_id, kind)
       VALUES ($1, $2, $3, 'survived')`,
      [workspaceId, runId, topicId],
    );

    await database.execute(`
      ALTER TABLE topic_memberships
        DROP CONSTRAINT topic_memberships_workspace_id_fkey,
        DROP CONSTRAINT topic_memberships_workspace_id_run_id_fkey,
        DROP CONSTRAINT topic_memberships_workspace_id_topic_id_fkey,
        DROP CONSTRAINT topic_memberships_workspace_id_message_id_fkey,
        DROP COLUMN workspace_id;
      ALTER TABLE topic_transitions
        DROP CONSTRAINT topic_transitions_workspace_id_fkey,
        DROP CONSTRAINT topic_transitions_workspace_id_run_id_fkey,
        DROP CONSTRAINT topic_transitions_workspace_id_topic_id_fkey,
        DROP COLUMN workspace_id;
      ALTER TABLE topics
        DROP CONSTRAINT topics_workspace_id_created_run_id_fkey,
        DROP CONSTRAINT topics_workspace_id_last_seen_run_id_fkey,
        DROP CONSTRAINT topics_workspace_id_id_key;
      ALTER TABLE topic_census_runs DROP CONSTRAINT topic_census_runs_workspace_id_id_key;
    `);

    await expect(applyTestMigration(database, topicCensusRepairMigration)).resolves.not.toThrow();

    const [membership] = await database.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM topic_memberships WHERE run_id = $1 AND message_id = $2",
      [runId, messageId],
    );
    const [transition] = await database.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM topic_transitions WHERE run_id = $1 AND topic_id = $2",
      [runId, topicId],
    );
    expect(membership.workspace_id).toBe(workspaceId);
    expect(transition.workspace_id).toBe(workspaceId);

    const constraints = await database.query<{ name: string }>(
      `SELECT conname AS name
       FROM pg_constraint
       WHERE conrelid IN ('topic_memberships'::regclass, 'topic_transitions'::regclass)
       ORDER BY conname`,
    );
    expect(constraints.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "topic_memberships_workspace_id_run_id_fkey",
      "topic_memberships_workspace_id_topic_id_fkey",
      "topic_memberships_workspace_id_message_id_fkey",
      "topic_transitions_workspace_id_run_id_fkey",
      "topic_transitions_workspace_id_topic_id_fkey",
    ]));
  });
});

describeIfDatabase("topic transition uniqueness migration", () => {
  const isolatedName = `mig166_topic_transition_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${isolatedName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, isolatedName));
    await runTestMigrationsBefore(database, topicTransitionUniquenessMigration);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    if (admin) {
      await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}"`);
      await admin.close().catch(() => undefined);
    }
  });

  it("keeps the earliest non-dissolved correction per run/topic before creating the unique index", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const runId = randomUUID();
    const topicId = randomUUID();
    const earliestId = randomUUID();
    const laterId = randomUUID();
    const latestId = randomUUID();
    await database.execute(
      "INSERT INTO accounts(id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig166-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces(id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      `INSERT INTO topic_census_runs(
         id, workspace_id, window_start, window_end, question_count, seed, params_json
       ) VALUES ($1, $2, now() - interval '1 day', now(), 1, 'seed', '{}'::jsonb)`,
      [runId, workspaceId],
    );
    await database.execute(
      `INSERT INTO topics(
         id, workspace_id, centroid, dimensions, radius, title, description,
         created_run_id, last_seen_run_id
       ) VALUES ($1, $2, '[1,0,0]'::vector, 3, 0.1, 'Topic', 'Description', $3, $3)`,
      [topicId, workspaceId, runId],
    );
    await database.execute(
      `INSERT INTO topic_transitions(
         id, workspace_id, run_id, topic_id, kind, created_at
       ) VALUES
         ($1, $2, $3, $4, 'dissolved', '2026-07-01T00:00:00.000Z'::timestamptz),
         ($5, $2, $3, $4, 'survived', '2026-07-01T00:00:01.000Z'::timestamptz),
         ($6, $2, $3, $4, 'emerged', '2026-07-01T00:00:02.000Z'::timestamptz)`,
      [earliestId, workspaceId, runId, topicId, laterId, latestId],
    );

    await expect(applyTestMigration(database, topicTransitionUniquenessMigration)).resolves.not.toThrow();

    const transitions = await database.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM topic_transitions WHERE run_id = $1 AND topic_id = $2",
      [runId, topicId],
    );
    expect(transitions).toEqual([{ id: laterId, kind: "survived" }]);
    await expect(database.execute(
      `INSERT INTO topic_transitions(workspace_id, run_id, topic_id, kind)
       VALUES ($1, $2, $3, 'survived')`,
      [workspaceId, runId, topicId],
    )).rejects.toMatchObject({ code: "23505" });
  });
});
