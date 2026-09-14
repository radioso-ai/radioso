import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient, QueryResultRow } from "pg";

import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../src/shared/infra/kysely/kyselyDatabase.js";
import { validateRoutineDefinition, type RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { testMigrationsPath } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
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

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

const createClientBackedDatabase = (client: PoolClient): Database => {
  // Back Kysely with the SAME client the raw helpers use, so Kysely queries run inside
  // this test's per-test schema (search_path) and open transaction — a fresh pool would
  // miss both. The pool's connect() hands back the client with release() neutered.
  const pool = {
    async connect() {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "release") {
            return () => undefined;
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as Database["pool"];

  return {
  pool,
  kysely: createKyselyDatabase(pool),
  async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await client.query<T>(text, params);
    return result.rows;
  },
  async queryOptional<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const result = await client.query<T>(text, params);
    return result.rows[0] ?? null;
  },
  async queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
    const result = await client.query<T>(text, params);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Expected query to return one row");
    }
    return row;
  },
  async execute(text: string, params: unknown[] = []): Promise<number> {
    const result = await client.query(text, params);
    return result.rowCount ?? 0;
  },
  async withTransaction<T>(callback: (transactionClient: PoolClient) => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  },
  async close(): Promise<void> {},
  };
};

const createRoutineSchema = async (client: PoolClient, schema: string): Promise<void> => {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query(`
    CREATE TABLE workspaces (
      id UUID PRIMARY KEY
    );

    CREATE TABLE agents (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
    );

    -- Shadows public.agent_drafts via search_path: the real table has FKs to
    -- public.agents/public.workspaces that this fixture's synthetic ids never satisfy.
    CREATE TABLE agent_drafts (
      agent_id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      base_published_revision_id UUID,
      snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (generation > 0)
    );

    CREATE TABLE routine_definition (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL,
      lineage_id UUID NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      -- Retired lifecycle column. It still carries the CHECK constraint and still gates the
      -- webhook-destination triggers, so the fixture keeps it exactly as production has it.
      status TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      activation_trigger_description TEXT NOT NULL,
      activation_gate_ref TEXT NULL,
      activation_priority INTEGER NOT NULL DEFAULT 0,
      activation_reentry_mode TEXT NOT NULL DEFAULT 'once_per_conversation',
      activation_coverage_criteria JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(agent_id, name, version),
      CHECK (version > 0),
      CHECK (status IN ('draft', 'published', 'superseded', 'archived'))
    );

    CREATE TABLE routine_slot (
      definition_id UUID NOT NULL REFERENCES routine_definition(id) ON DELETE CASCADE,
      stable_slot_id TEXT NOT NULL,
      key TEXT NOT NULL,
      type TEXT NOT NULL,
      required BOOLEAN NOT NULL DEFAULT TRUE,
      description TEXT NULL,
      ordinal INTEGER NOT NULL,
      mutable BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (definition_id, stable_slot_id),
      UNIQUE(definition_id, key),
      UNIQUE(definition_id, ordinal)
    );

    CREATE TABLE routine_step (
      definition_id UUID NOT NULL REFERENCES routine_definition(id) ON DELETE CASCADE,
      stable_step_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      instruction TEXT NOT NULL,
      tool_ref TEXT NULL,
      action_type TEXT NULL,
      capture_key TEXT NULL,
      options JSONB NULL,
      ordinal INTEGER NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (definition_id, stable_step_id),
      UNIQUE(definition_id, ordinal),
      CHECK (kind IN ('chat', 'tool', 'action', 'approval'))
    );

    CREATE TABLE routine_transition (
      definition_id UUID NOT NULL REFERENCES routine_definition(id) ON DELETE CASCADE,
      from_step TEXT NOT NULL,
      to_ref TEXT NOT NULL,
      guard_kind TEXT NOT NULL,
      guard_text TEXT NULL,
      outcome_status TEXT NULL,
      counter_limit INTEGER NULL,
      field_ref TEXT NULL,
      field_op TEXT NULL,
      field_value JSONB NULL,
      field_values JSONB NULL,
      field_unit TEXT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (definition_id, from_step, ordinal)
    );

    CREATE TABLE routine_terminal (
      definition_id UUID NOT NULL REFERENCES routine_definition(id) ON DELETE CASCADE,
      stable_step_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      instruction TEXT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (definition_id, stable_step_id),
      UNIQUE(definition_id, ordinal)
    );

    CREATE TABLE routine_completion_export (
      definition_id UUID PRIMARY KEY REFERENCES routine_definition(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      trigger_kinds TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      destination_ref TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX idx_routine_definition_one_draft_per_lineage
      ON routine_definition (lineage_id)
      WHERE status = 'draft';
    CREATE UNIQUE INDEX idx_routine_definition_one_published_per_lineage
      ON routine_definition (lineage_id)
      WHERE status = 'published';
    CREATE UNIQUE INDEX idx_routine_definition_lineage_version
      ON routine_definition (lineage_id, version);
  `);
};

const installWorkspaceWebhookDestinationTriggers = async (client: PoolClient): Promise<void> => {
  // Keep this copied-DDL fixture aligned with the production trigger in
  // backend/src/db/migrations/089_workspace_webhook_destinations.sql.
  const migration089 = await readFile(path.join(testMigrationsPath, "089_workspace_webhook_destinations.sql"), "utf8");
  await client.query(migration089);
};

const draftInput = (name = "postgres-lifecycle", label = "v1"): RoutineDefinitionDraftInput => ({
  name,
  enabled: true,
  activation: {
    triggerDescription: `When the user asks for ${label}.`,
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [{
    stableSlotId: "slot_topic",
    key: "topic",
    type: "text",
    required: true,
    description: "Topic",
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "step_collect",
    kind: "chat",
    instruction: `${label}: collect {{slot.topic}}.`,
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "step_collect",
    toRef: "terminal_complete",
    guardKind: "llm",
    guardText: "The user answered.",
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "terminal_complete",
    kind: "complete",
    instruction: `${label}: done.`,
    ordinal: 1,
  }],
});

describeIfDatabase("RoutineDefinitionRepository Postgres integration", () => {
  let database: Database;
  let backingDatabase: Database;
  let client: PoolClient;
  let schema: string;
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    backingDatabase = new Database(integrationDatabaseUrl!);
    client = await backingDatabase.pool.connect();
    schema = `routine_repo_${randomUUID().replaceAll("-", "_")}`;
    await createRoutineSchema(client, schema);
    await installWorkspaceWebhookDestinationTriggers(client);
    database = createClientBackedDatabase(client);
    workspaceId = randomUUID();
    agentId = randomUUID();
    await database.execute(`INSERT INTO workspaces (id) VALUES ($1)`, [workspaceId]);
    await database.execute(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2)`, [agentId, workspaceId]);
    await database.execute(
      `INSERT INTO agent_drafts (agent_id, workspace_id, snapshot)
       VALUES ($1, $2, '{"customInstruction":null,"directives":[],"routines":[],"contextVariableEnablements":[]}'::jsonb)`,
      [agentId, workspaceId],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
    }
    if (backingDatabase) {
      await backingDatabase.close();
    }
  });

  it("creates one live row per routine and edits it in place against real SQL indexes", async () => {
    const repository = new RoutineDefinitionRepository(database.kysely);
    const created = await repository.createDraft(agentId, draftInput("postgres-lifecycle", "v1"));

    expect(created).toMatchObject({ version: 1, lineageId: created.id, enabled: true });
    const storedRow = await database.queryOne<{ status: string; enabled: boolean; lineage_id: string }>(
      `SELECT status, enabled, lineage_id::text FROM routine_definition WHERE id = $1`,
      [created.id],
    );
    expect(storedRow).toEqual({ status: "published", enabled: true, lineage_id: created.id });

    // idx_routine_definition_lineage_version keeps the canonical-row choice total: a lineage
    // cannot hold two rows at the same version.
    await expect(database.execute(
      `INSERT INTO routine_definition (
         agent_id, lineage_id, version, name, status, activation_trigger_description, activation_priority
       )
       VALUES ($1, $2, 1, 'postgres-lifecycle-duplicate-version', 'published', 'duplicate version', 0)`,
      [agentId, created.lineageId],
    ))
      .rejects.toMatchObject({ code: "23505" });

    // Editing rewrites the same row; nothing branches the lineage.
    const edited = await repository.updateDraft(agentId, created.id, draftInput("postgres-lifecycle", "v2"));
    expect(edited.id).toBe(created.id);
    expect(edited.version).toBe(1);
    const lineageRows = await database.query<{ id: string; version: number; status: string }>(
      `SELECT id::text, version, status FROM routine_definition WHERE lineage_id = $1`,
      [created.lineageId],
    );
    expect(lineageRows).toEqual([{ id: created.id, version: 1, status: "published" }]);

    // Taking it out of service touches `enabled` only, and drops it from the activation read.
    const parked = await repository.setEnabledWithAgentDraft(workspaceId, agentId, created.id, false);
    expect(parked).toMatchObject({ id: created.id, enabled: false });
    expect(await repository.listActiveByAgent(agentId)).toEqual([]);
    expect((await repository.listByAgent(agentId)).map((routine) => routine.id)).toEqual([created.id]);
    expect((await database.queryOne<{ status: string }>(
      `SELECT status FROM routine_definition WHERE id = $1`,
      [created.id],
    )).status).toBe("published");

    await expect(repository.deleteDraft(agentId, created.id)).resolves.toEqual({ outcome: "deleted" });
  });

  it("collapses a legacy multi-version lineage to its highest version and still resolves pins", async () => {
    const repository = new RoutineDefinitionRepository(database.kysely);
    const legacyAgentId = randomUUID();
    await database.execute(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2)`, [legacyAgentId, workspaceId]);
    await database.execute(
      `INSERT INTO agent_drafts (agent_id, workspace_id, snapshot)
       VALUES ($1, $2, '{"customInstruction":null,"directives":[],"routines":[],"contextVariableEnablements":[]}'::jsonb)`,
      [legacyAgentId, workspaceId],
    );
    const lineageId = randomUUID();
    const supersededId = randomUUID();
    const canonicalId = randomUUID();
    // Written the way the retired publish/revise flow left a lineage behind; nothing in the
    // application can produce this shape any more.
    await database.execute(
      `INSERT INTO routine_definition (
         id, agent_id, lineage_id, version, name, status, activation_trigger_description, activation_priority
       )
       VALUES
         ($1, $3, $4, 1, 'postgres-legacy-lineage', 'superseded', 'legacy v1', 0),
         ($2, $3, $4, 2, 'postgres-legacy-lineage', 'published', 'legacy v2', 0)`,
      [supersededId, canonicalId, legacyAgentId, lineageId],
    );

    const listed = await repository.listByAgent(legacyAgentId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: canonicalId, version: 2, lineageId });
    expect((await repository.findById(legacyAgentId, supersededId))?.id).toBe(canonicalId);
    expect((await repository.findPinnedById(legacyAgentId, supersededId))).toMatchObject({
      id: supersededId,
      version: 1,
    });
    expect((await repository.listVersionsByAgent(legacyAgentId)).map((routine) => routine.id))
      .toEqual([supersededId, canonicalId]);

    // A branched lineage only exists because an earlier version was published, so it may still
    // back an in-flight conversation's pin: deleting disables the canonical row rather than
    // removing the lineage's history, keeping findPinnedById resolving for both versions.
    await expect(repository.deleteDraft(legacyAgentId, canonicalId)).resolves.toEqual({ outcome: "deleted" });
    expect((await repository.findById(legacyAgentId, canonicalId))?.enabled).toBe(false);
    expect((await repository.findPinnedById(legacyAgentId, supersededId))?.id).toBe(supersededId);
    expect((await repository.listVersionsByAgent(legacyAgentId)).map((routine) => routine.id))
      .toEqual([supersededId, canonicalId]);
  });

  it("round-trips deterministic field guards (ref/op/value/values/unit) through real SQL", async () => {
    const repository = new RoutineDefinitionRepository(database.kysely);
    const draft = await repository.createDraft(agentId, {
      name: "field-guard-roundtrip",
      enabled: true,
      activation: { triggerDescription: "When checking eligibility.", gateRef: null, priority: 5, reentryMode: "always" },
      slots: [
        { stableSlotId: "slot_amount", key: "amount", type: "number", required: true, description: "Order total", ordinal: 0 },
        { stableSlotId: "slot_tier", key: "tier", type: "text", required: true, description: "Tier", ordinal: 1 },
      ],
      steps: [{
        stableStepId: "step_decide",
        kind: "chat",
        instruction: "Evaluate {{slot.amount}} for {{slot.tier}}.",
        toolRef: null,
        ordinal: 0,
        metadata: {},
      }],
      transitions: [
        {
          fromStep: "step_decide", toRef: "terminal_big", guardKind: "field",
          guardText: null, outcomeStatus: null, counterLimit: null,
          fieldRef: "amount", fieldOp: "gte", fieldValue: 100, ordinal: 0,
        },
        {
          fromStep: "step_decide", toRef: "terminal_member", guardKind: "field",
          guardText: null, outcomeStatus: null, counterLimit: null,
          fieldRef: "tier", fieldOp: "in", fieldValues: ["gold", "platinum"], ordinal: 1,
        },
        {
          fromStep: "step_decide", toRef: "terminal_standard", guardKind: "default",
          guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 2,
        },
      ],
      terminals: [
        { stableStepId: "terminal_big", kind: "complete", instruction: "Free shipping.", ordinal: 0 },
        { stableStepId: "terminal_member", kind: "complete", instruction: "Member perk.", ordinal: 1 },
        { stableStepId: "terminal_standard", kind: "complete", instruction: "Standard.", ordinal: 2 },
      ],
    });

    const reloaded = await repository.findById(agentId, draft.id);
    const numeric = reloaded?.transitions.find((transition) => transition.toRef === "terminal_big");
    const membership = reloaded?.transitions.find((transition) => transition.toRef === "terminal_member");

    expect(numeric).toMatchObject({ guardKind: "field", fieldRef: "amount", fieldOp: "gte", fieldValue: 100 });
    expect(membership).toMatchObject({ guardKind: "field", fieldRef: "tier", fieldOp: "in", fieldValues: ["gold", "platinum"] });
  });

  it("round-trips an approval step's capture key and options through real SQL (issue #755)", async () => {
    const repository = new RoutineDefinitionRepository(database.kysely);
    const draft = await repository.createDraft(agentId, {
      name: "approval-roundtrip",
      enabled: true,
      activation: { triggerDescription: "When a refund needs a manager.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
      slots: [],
      steps: [
        {
          stableStepId: "review",
          kind: "approval",
          instruction: "Approve or deny the refund.",
          toolRef: null,
          actionType: null,
          captureKey: "refund_decision",
          options: [
            { id: "approve", label: "Approve", description: "Issue the refund" },
            { id: "deny", label: "Deny" },
          ],
          ordinal: 0,
          metadata: {},
        },
        {
          stableStepId: "issue",
          kind: "chat",
          instruction: "Issue the refund.",
          toolRef: null,
          ordinal: 1,
          metadata: {},
        },
      ],
      transitions: [
        {
          fromStep: "review", toRef: "issue", guardKind: "field", guardText: null, outcomeStatus: null, counterLimit: null,
          fieldRef: "refund_decision.id", fieldOp: "equals", fieldValue: "approve", ordinal: 0,
        },
        {
          fromStep: "review", toRef: "terminal_done", guardKind: "field", guardText: null, outcomeStatus: null, counterLimit: null,
          fieldRef: "refund_decision.id", fieldOp: "equals", fieldValue: "deny", ordinal: 1,
        },
        {
          fromStep: "issue", toRef: "terminal_done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 2,
        },
      ],
      terminals: [{ stableStepId: "terminal_done", kind: "complete", instruction: "Done.", ordinal: 0 }],
    });

    const reloaded = await repository.findById(agentId, draft.id);
    const approvalStep = reloaded?.steps.find((step) => step.kind === "approval");
    expect(approvalStep).toMatchObject({
      stableStepId: "review",
      captureKey: "refund_decision",
      options: [
        { id: "approve", label: "Approve", description: "Issue the refund" },
        { id: "deny", label: "Deny", description: null },
      ],
    });
    // A non-approval step must not gain capture key / options on the round-trip.
    const chatStep = reloaded?.steps.find((step) => step.stableStepId === "issue");
    expect(chatStep).not.toHaveProperty("captureKey");
    expect(chatStep).not.toHaveProperty("options");

    // The persisted gate still validates clean: the decision field guards resolve against
    // the recovered capture key (a dropped captureKey would surface field_guard_unknown_reference).
    expect(validateRoutineDefinition(reloaded!)).toMatchObject({ ok: true });
  });

  it("repairs dirty pre-existing data before building migration 090 lifecycle indexes", async () => {
    const schema = `routine_migration_${randomUUID().replaceAll("-", "_")}`;
    const migration090 = await readFile(path.join(testMigrationsPath, "090_routine_lineage_lifecycle.sql"), "utf8");
    const agentIdForMigration = randomUUID();
    const publishedOld = randomUUID();
    const publishedNew = randomUUID();
    const draftOld = randomUUID();
    const draftNew = randomUUID();

    await database.withTransaction(async (client) => {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}, public`);
      await client.query(`
        CREATE TABLE routine_definition (
          id UUID PRIMARY KEY,
          agent_id UUID NOT NULL,
          version INTEGER NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          activation_trigger_description TEXT NOT NULL,
          activation_gate_ref TEXT NULL,
          activation_priority INTEGER NOT NULL DEFAULT 0,
          activation_coverage_criteria JSONB NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(agent_id, name, version)
        )
      `);
      await client.query(
        `INSERT INTO routine_definition (
           id, agent_id, version, name, status, activation_trigger_description, activation_priority, created_at
         )
         VALUES
           ($1, $5, 1, 'dirty-routine', 'published', 'old published', 0, NOW() - INTERVAL '4 days'),
           ($2, $5, 2, 'dirty-routine', 'published', 'new published', 0, NOW() - INTERVAL '3 days'),
           ($3, $5, 3, 'dirty-routine', 'draft', 'old draft', 0, NOW() - INTERVAL '2 days'),
           ($4, $5, 4, 'dirty-routine', 'draft', 'new draft', 0, NOW() - INTERVAL '1 day')`,
        [publishedOld, publishedNew, draftOld, draftNew, agentIdForMigration],
      );

      await client.query(migration090);

      const rows = await client.query<{
        id: string;
        lineage_id: string;
        status: string;
      }>(
        `SELECT id::text, lineage_id::text, status
         FROM routine_definition
         ORDER BY version ASC`,
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      expect(byId.get(publishedNew)!.status).toBe("published");
      expect(byId.get(publishedOld)!.status).toBe("superseded");
      expect(byId.get(draftNew)!.status).toBe("draft");
      expect(byId.get(draftOld)!.status).toBe("draft");
      expect(byId.get(draftOld)!.lineage_id).not.toBe(byId.get(draftNew)!.lineage_id);

      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = 'routine_definition'`,
        [schema],
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
        "idx_routine_definition_one_draft_per_lineage",
        "idx_routine_definition_one_published_per_lineage",
        "idx_routine_definition_lineage_version",
      ]));
    });

    await database.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  it("rewrites legacy compiled-id scope tags to definition ids in migration 091", async () => {
    const schema = `routine_tags_${randomUUID().replaceAll("-", "_")}`;
    const migration091 = await readFile(path.join(testMigrationsPath, "091_routine_scope_tag_definition_ids.sql"), "utf8");
    const agentIdForMigration = randomUUID();
    const definitionId = randomUUID();
    const directiveId = randomUUID();
    const untouchedDirectiveId = randomUUID();

    await database.withTransaction(async (client) => {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(`
        CREATE TABLE routine_definition (
          id UUID PRIMARY KEY,
          agent_id UUID NOT NULL,
          version INTEGER NOT NULL,
          name TEXT NOT NULL,
          activation_coverage_criteria JSONB NULL,
          UNIQUE(agent_id, name, version)
        )
      `);
      await client.query(`
        CREATE TABLE agent_directives (
          id UUID PRIMARY KEY,
          agent_id UUID NOT NULL,
          scope_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `INSERT INTO routine_definition (id, agent_id, version, name)
         VALUES ($1, $2, 1, 'intake: priority')`,
        [definitionId, agentIdForMigration],
      );
      await client.query(
        `INSERT INTO agent_directives (id, agent_id, scope_tags)
         VALUES
           ($1, $3::uuid, ARRAY[
             'routine:routine:' || $3::text || ':intake: priority:v1',
             'step:routine:' || $3::text || ':intake: priority:v1:ask_topic',
             'tone:friendly'
           ]),
           ($2, $3::uuid, ARRAY['routine:routine:' || $3::text || ':missing-routine:v9'])`,
        [directiveId, untouchedDirectiveId, agentIdForMigration],
      );

      await client.query(migration091);

      const rewritten = await client.query<{ scope_tags: string[] }>(
        `SELECT scope_tags FROM agent_directives WHERE id = $1`,
        [directiveId],
      );
      expect(rewritten.rows[0].scope_tags).toEqual([
        `routine:${definitionId}`,
        `step:${definitionId}:ask_topic`,
        "tone:friendly",
      ]);

      const untouched = await client.query<{ scope_tags: string[] }>(
        `SELECT scope_tags FROM agent_directives WHERE id = $1`,
        [untouchedDirectiveId],
      );
      expect(untouched.rows[0].scope_tags).toEqual([
        `routine:routine:${agentIdForMigration}:missing-routine:v9`,
      ]);

      // Re-runnable: a second pass finds no legacy-format tags to rewrite.
      await client.query(migration091);
    });

    await database.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
});
