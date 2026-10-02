import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migrationFile = "208_test_execution_seed_summary_backfill.sql";

const canReach = async (url?: string) => {
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

const isolatedUrl = (base: string, name: string) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("test execution seed summary backfill (208)", () => {
  const databaseName = `mig208_${randomUUID().replaceAll("-", "")}`;
  const accountId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID(), revisionId = randomUUID();
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, migrationFile);
    const snapshot = JSON.stringify({ customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] });
    await database.execute("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')", [accountId, `mig208-${accountId}@example.com`]);
    await database.execute("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)", [workspaceId, accountId, `rk-${workspaceId}`]);
    await database.execute("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Agent')", [agentId, workspaceId]);
    await database.execute("INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation) VALUES ($1, $2, $3, $4::jsonb, 1)", [revisionId, agentId, workspaceId, snapshot]);
  }, 120_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  type Entry = { turnId: string; role: "user" | "assistant"; content: string };
  const user = (content: string, turnId = randomUUID()): Entry => ({ turnId, role: "user", content });
  const reply = (content: string, turnId = randomUUID()): Entry => ({ turnId, role: "assistant", content });
  // Written the way a start was before 207: the thread in side 0's history, no summary columns.
  const execution = async (mode: "single" | "compare", history: Entry[], sentTurns: { turnId: string; message: string }[] = []) => {
    const id = randomUUID();
    await database.execute(
      "INSERT INTO agent_test_executions (id, workspace_id, agent_id, mode, state, test_values, idempotency_key) VALUES ($1, $2, $3, $4, 'completed', '[]'::jsonb, $5)",
      [id, workspaceId, agentId, mode, id],
    );
    const entries = history.map((entry, index) => ({ ...entry, attemptId: randomUUID(), createdAt: new Date(index * 1000).toISOString() }));
    await database.execute(
      "INSERT INTO agent_test_execution_sides (id, execution_id, workspace_id, agent_id, revision_id, conversation_id, state, history, side_ordinal) VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb, 0)",
      [randomUUID(), id, workspaceId, agentId, revisionId, randomUUID(), JSON.stringify(entries)],
    );
    for (const turn of sentTurns) {
      await database.execute(
        "INSERT INTO agent_test_execution_turns (execution_id, turn_id, message, input_fingerprint, state) VALUES ($1, $2, $3, 'fingerprint', 'completed')",
        [id, turn.turnId, turn.message],
      );
    }
    return id;
  };
  const summary = async (id: string) => (await database.query<{ seeded_turn_count: number; seeded_first_message: string | null }>(
    "SELECT seeded_turn_count, seeded_first_message FROM agent_test_executions WHERE id = $1",
    [id],
  ))[0];

  it("records the copied user messages no sent turn owns, skipping blank ones for the label, once", async () => {
    const operatorTurn = randomUUID(), plainTurn = randomUUID();
    const seeded = await execution("single", [
      user(""), user("\n\t"), user("copied question"), reply("copied answer"),
      user("operator question", operatorTurn), reply("answer", operatorTurn),
    ], [{ turnId: operatorTurn, message: "operator question" }]);
    const longSeeded = await execution("single", [user("q".repeat(5_000)), reply("ok")]);
    const plain = await execution("single", [reply("Hi!"), user("plain question", plainTurn)], [{ turnId: plainTurn, message: "plain question" }]);
    // Only a single-revision test can be seeded; a comparison's entries are left alone.
    const comparison = await execution("compare", [user("not a seed")]);

    await applyTestMigration(database, migrationFile);

    expect(await summary(seeded)).toEqual({ seeded_turn_count: 3, seeded_first_message: "copied question" });
    expect(await summary(longSeeded)).toEqual({ seeded_turn_count: 1, seeded_first_message: "q".repeat(201) });
    expect(await summary(plain)).toEqual({ seeded_turn_count: 0, seeded_first_message: null });
    expect(await summary(comparison)).toEqual({ seeded_turn_count: 0, seeded_first_message: null });

    await database.execute("UPDATE agent_test_executions SET seeded_first_message = 'kept' WHERE id = $1", [seeded]);
    await applyTestMigration(database, migrationFile);
    expect(await summary(seeded)).toEqual({ seeded_turn_count: 3, seeded_first_message: "kept" });
  });
});
