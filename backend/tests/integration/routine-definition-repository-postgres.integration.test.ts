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
      }) as PoolClient;
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
  } as Database;
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

    CREATE TABLE routine_definition (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL,
      lineage_id UUID NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      activation_trigger_description TEXT NOT NULL,
      activation_gate_ref TEXT NULL,
      activation_priority INTEGER NOT NULL DEFAULT 0,
      activation_reentry_mode TEXT NOT NULL DEFAULT 'once_per_conversation',
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

  it("publishes, revises, archives, and restores against real SQL indexes", async () => {
    const repository = new RoutineDefinitionRepository(database.kysely);
    const draftV1 = await repository.createDraft(agentId, draftInput("postgres-lifecycle", "v1"));
    const publishedV1 = await repository.publish(agentId, draftV1.id);

    expect(publishedV1.id).toBe(draftV1.id);
    expect(publishedV1.version).toBe(1);
    expect(publishedV1.status).toBe("published");

    const revision = await repository.createRevisionDraft(agentId, publishedV1.id);
    if (!revision) {
      throw new Error("expected revision draft");
    }
    expect(revision.version).toBe(2);
    await expect(database.execute(
      `INSERT INTO routine_definition (
         agent_id, lineage_id, version, name, status, activation_trigger_description, activation_priority
       )
       VALUES ($1, $2, 3, 'postgres-lifecycle', 'draft', 'duplicate draft', 0)`,
      [agentId, publishedV1.lineageId],
    ))
      .rejects.toMatchObject({ code: "23505" });

    const publishedV2 = await repository.publish(agentId, revision.id);
    expect(publishedV2.id).toBe(revision.id);
    expect(publishedV2.version).toBe(2);
    expect(publishedV2.status).toBe("published");
    await expect(database.execute(
      `INSERT INTO routine_definition (
         agent_id, lineage_id, version, name, status, activation_trigger_description, activation_priority
       )
       VALUES ($1, $2, 3, 'postgres-lifecycle', 'published', 'duplicate published', 0)`,
      [agentId, publishedV2.lineageId],
    ))
      .rejects.toMatchObject({ code: "23505" });

    const lineageRows = await database.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM routine_definition
       WHERE lineage_id = $1
       GROUP BY status`,
      [publishedV1.lineageId],
    );
    expect(Object.fromEntries(lineageRows.map((row) => [row.status, row.count]))).toMatchObject({
      published: "1",
      superseded: "1",
    });

    await expect(repository.publish(agentId, revision.id)).rejects.toThrow("routine_definition_publish_conflict");
    await expect(repository.createRevisionDraft(agentId, publishedV2.id)).resolves.toMatchObject({ status: "draft" });
    await expect(repository.createRevisionDraft(agentId, publishedV2.id)).resolves.toMatchObject({ status: "draft" });

    const draftCount = await database.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM routine_definition
       WHERE lineage_id = $1 AND status = 'draft'`,
      [publishedV2.lineageId],
    );
    expect(draftCount.count).toBe("1");

    expect(await repository.archive(agentId, publishedV1.id)).toBe(false);
    expect(await repository.archive(agentId, publishedV2.id)).toBe(true);

    const draftsAfterArchive = await database.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM routine_definition
       WHERE lineage_id = $1 AND status = 'draft'`,
      [publishedV2.lineageId],
    );
    expect(draftsAfterArchive.count).toBe("0");

    expect(await repository.restore(agentId, publishedV1.id)).toBe(false);
    expect(await repository.restore(agentId, publishedV2.id)).toBe(true);
  });

  it("round-trips deterministic field guards (ref/op/value/values/unit) through real SQL", async () => {
    const repository = new RoutineDefinitionRepository(database.kysely);
    const draft = await repository.createDraft(agentId, {
      name: "field-guard-roundtrip",
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

  it("rejects publish when an enabled completion export destination was deleted before publish", async () => {
    const repository = new RoutineDefinitionRepository(database.kysely);
    const destinationId = randomUUID();
    await database.execute(
      `INSERT INTO workspace_webhook_destinations (
         id, workspace_id, name, url, secret_ciphertext, encryption_key_id
       )
       VALUES ($1, $2, 'Publish race', 'https://example.test/webhook', 'ciphertext', 'test-key')`,
      [destinationId, workspaceId],
    );
    const draft = await repository.createDraft(agentId, {
      ...draftInput("postgres-publish-export", "publish-export"),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: destinationId,
      },
    });
    await database.execute(`DELETE FROM workspace_webhook_destinations WHERE id = $1`, [destinationId]);

    await expect(repository.publish(agentId, draft.id))
      .rejects.toMatchObject({
        code: "23503",
        constraint: "routine_completion_export_destination_ref_published_fk",
      });

    const row = await database.queryOne<{ status: string }>(
      `SELECT status FROM routine_definition WHERE id = $1`,
      [draft.id],
    );
    expect(row.status).toBe("draft");
    const danglingPublished = await database.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM routine_definition d
       JOIN routine_completion_export ce ON ce.definition_id = d.id
       LEFT JOIN workspace_webhook_destinations destination
         ON destination.workspace_id = $1
        AND destination.id::text = lower(ce.destination_ref)
       WHERE d.id = $2
         AND d.status = 'published'
         AND ce.enabled = TRUE
         AND destination.id IS NULL`,
      [workspaceId, draft.id],
    );
    expect(danglingPublished.count).toBe("0");
  });

  it("rejects restore when an enabled completion export destination was deleted while archived", async () => {
    const repository = new RoutineDefinitionRepository(database.kysely);
    const destinationId = randomUUID();
    await database.execute(
      `INSERT INTO workspace_webhook_destinations (
         id, workspace_id, name, url, secret_ciphertext, encryption_key_id
       )
       VALUES ($1, $2, 'Restore race', 'https://example.test/restore', 'ciphertext', 'test-key')`,
      [destinationId, workspaceId],
    );
    const draft = await repository.createDraft(agentId, {
      ...draftInput("postgres-restore-export", "restore-export"),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: destinationId,
      },
    });
    const published = await repository.publish(agentId, draft.id);
    expect(await repository.archive(agentId, published.id)).toBe(true);
    await database.execute(`DELETE FROM workspace_webhook_destinations WHERE id = $1`, [destinationId]);

    await expect(repository.restore(agentId, published.id))
      .rejects.toMatchObject({
        code: "23503",
        constraint: "routine_completion_export_destination_ref_published_fk",
      });

    const row = await database.queryOne<{ status: string }>(
      `SELECT status FROM routine_definition WHERE id = $1`,
      [published.id],
    );
    expect(row.status).toBe("archived");
    const danglingPublished = await database.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM routine_definition d
       JOIN routine_completion_export ce ON ce.definition_id = d.id
       LEFT JOIN workspace_webhook_destinations destination
         ON destination.workspace_id = $1
        AND destination.id::text = lower(ce.destination_ref)
       WHERE d.id = $2
         AND d.status = 'published'
         AND ce.enabled = TRUE
         AND destination.id IS NULL`,
      [workspaceId, published.id],
    );
    expect(danglingPublished.count).toBe("0");
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

  it("rejects a draft save that races publish without mutating the published children", async () => {
    const repository = new RoutineDefinitionRepository(database.kysely);
    const draft = await repository.createDraft(agentId, draftInput("postgres-update-race", "v1"));
    const published = await repository.publish(agentId, draft.id);

    // The service pre-check has already passed by the time publish commits;
    // the repository row-count guard is the last line of defense.
    await expect(repository.updateDraft(agentId, published.id, draftInput("postgres-update-race", "raced")))
      .rejects.toThrow(`routine_definition_update_conflict:${published.id}`);

    const steps = await database.query<{ instruction: string }>(
      `SELECT instruction FROM routine_step WHERE definition_id = $1`,
      [published.id],
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.instruction).toContain("v1");
    expect(steps[0]!.instruction).not.toContain("raced");
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
      expect(rewritten.rows[0]!.scope_tags).toEqual([
        `routine:${definitionId}`,
        `step:${definitionId}:ask_topic`,
        "tone:friendly",
      ]);

      const untouched = await client.query<{ scope_tags: string[] }>(
        `SELECT scope_tags FROM agent_directives WHERE id = $1`,
        [untouchedDirectiveId],
      );
      expect(untouched.rows[0]!.scope_tags).toEqual([
        `routine:routine:${agentIdForMigration}:missing-routine:v9`,
      ]);

      // Re-runnable: a second pass finds no legacy-format tags to rewrite.
      await client.query(migration091);
    });

    await database.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
});
