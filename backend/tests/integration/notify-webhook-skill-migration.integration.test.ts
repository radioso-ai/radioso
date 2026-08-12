import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations, testMigrationsPath } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
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

const describeIfDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("notify and completion-export skill migration", () => {
  const isolatedName = `mig111_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let agentRepository: AgentRepository;
  let routineRepository: RoutineDefinitionRepository;
  let migration111Sql: string;
  let correctionMigrationSql: string;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${isolatedName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, isolatedName));
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database.kysely);
    agentRepository = new AgentRepository(database.kysely);
    routineRepository = new RoutineDefinitionRepository(database.kysely);
    await database.execute(
      "CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    );
    // Full schema, then re-apply 111 after seeding legacy contact/webhook-export settings so we
    // exercise its (idempotent) projection — mirrors the other migration projection tests.
    await runAllTestMigrations(database);
    migration111Sql = await readFile(path.join(testMigrationsPath, "111_notify_and_completion_export_skills.sql"), "utf8");
    correctionMigrationSql = await readFile(path.join(testMigrationsPath, "142_completion_export_skill_published_target.sql"), "utf8");
  });

  afterAll(async () => {
    try {
      await database?.close();
    } finally {
      if (admin) {
        await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => undefined);
        await admin.close();
      }
    }
  });

  it("creates contact_human and completion_export skills idempotently with preserved destinations", async () => {
    const account = await accountRepository.create({
      name: "US4 Migration",
      email: `us4-migration-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "US4 Migration");
    const agent = await agentRepository.create(workspace.id, {
      name: "US4 Agent",
      contactRequestsEnabled: true,
      contactRequestDelivery: {
        recipientEmails: ["sales@example.com"],
        webhook: { url: "https://hooks.example.com/contact" },
      },
      webhookExportsEnabled: true,
    });
    const destinationId = randomUUID();
    await database.execute(
      `INSERT INTO workspace_webhook_destinations (
         id, workspace_id, name, url, secret_ciphertext, encryption_key_id
       )
       VALUES ($1, $2, 'Completion Export', 'https://example.test/webhook', 'ciphertext', 'test-key')`,
      [destinationId, workspace.id],
    );
    const completionExportDraft = await routineRepository.createDraft(agent.id, {
      name: "Exporting routine",
      activation: { triggerDescription: "Start export", gateRef: null, priority: 1, reentryMode: "always" },
      slots: [],
      steps: [{
        stableStepId: "start",
        kind: "chat",
        instruction: "Ask.",
        toolRef: null,
        actionType: null,
        captureKey: null,
        metadata: {},
        ordinal: 0,
      }],
      transitions: [{ fromStep: "start", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 }],
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: destinationId,
      },
    });
    await routineRepository.publish(agent.id, completionExportDraft.id);

    await database.pool.query(migration111Sql);
    await database.pool.query(migration111Sql);

    const rows = await database.query<{
      skill_name: string;
      kind: string;
      target_type: string | null;
      target_id: string | null;
      invocation_mode: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }>(
      `SELECT skill_name, kind, target_type, target_id, invocation_mode, enabled, config
       FROM agent_skills
       WHERE agent_id = $1 AND skill_name IN ('contact_human', 'completion_export')
       ORDER BY skill_name ASC`,
      [agent.id],
    );

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.skill_name === "contact_human")).toMatchObject({
      kind: "notify",
      target_type: "notify_delivery",
      target_id: null,
      invocation_mode: "routine_named",
      enabled: true,
      config: {
        delivery: {
          recipientEmails: ["sales@example.com"],
          webhook: { url: "https://hooks.example.com/contact" },
        },
      },
    });
    expect(rows.find((row) => row.skill_name === "completion_export")).toMatchObject({
      kind: "webhook",
      target_type: "webhook_destination",
      target_id: destinationId,
      invocation_mode: "routine_named",
      enabled: true,
    });
  });

  it("corrects an untouched 111 target without overwriting a later skill edit", async () => {
    const account = await accountRepository.create({
      name: "Completion Export Published Migration",
      email: `completion-export-published-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Completion Export Published Migration");
    const agent = await agentRepository.create(workspace.id, {
      name: "Completion Export Published Agent",
      webhookExportsEnabled: true,
    });
    const publishedDestinationId = randomUUID();
    const draftDestinationId = randomUUID();
    const userEditedDestinationId = randomUUID();
    await database.execute(
      `INSERT INTO workspace_webhook_destinations (
         id, workspace_id, name, url, secret_ciphertext, encryption_key_id
       )
       VALUES
         ($1, $2, 'Published completion export', 'https://example.test/published', 'ciphertext', 'test-key'),
         ($3, $2, 'Draft completion export', 'https://example.test/draft', 'ciphertext', 'test-key'),
         ($4, $2, 'User edited completion export', 'https://example.test/user-edited', 'ciphertext', 'test-key')`,
      [publishedDestinationId, workspace.id, draftDestinationId, userEditedDestinationId],
    );
    const draftInput = (name: string, destinationRef: string) => ({
      name,
      activation: { triggerDescription: "Start export", gateRef: null, priority: 1, reentryMode: "always" as const },
      slots: [],
      steps: [{
        stableStepId: "start",
        kind: "chat" as const,
        instruction: "Ask.",
        toolRef: null,
        actionType: null,
        captureKey: null,
        metadata: {},
        ordinal: 0,
      }],
      transitions: [{ fromStep: "start", toRef: "done", guardKind: "default" as const, guardText: null, ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete" as const, instruction: "Done.", ordinal: 0 }],
      completionExport: { enabled: true, triggerKinds: ["complete"] as Array<"complete">, destinationRef },
    });
    const publishedDraft = await routineRepository.createDraft(
      agent.id,
      draftInput("Published completion export", publishedDestinationId),
    );
    await routineRepository.publish(agent.id, publishedDraft.id);
    const newerDraft = await routineRepository.createDraft(
      agent.id,
      draftInput("Newer draft completion export", draftDestinationId),
    );
    await database.execute(
      "UPDATE routine_definition SET updated_at = NOW() + INTERVAL '1 minute' WHERE id = $1",
      [newerDraft.id],
    );

    await database.pool.query(migration111Sql);
    await database.execute(
      "INSERT INTO schema_migrations (filename) VALUES ('111_notify_and_completion_export_skills.sql')",
    );

    const [seededSkill] = await database.query<{ target_id: string }>(
      "SELECT target_id FROM agent_skills WHERE agent_id = $1 AND skill_name = 'completion_export'",
      [agent.id],
    );
    expect(seededSkill).toEqual({ target_id: publishedDestinationId });

    await database.execute(
      `UPDATE agent_skills
       SET target_id = $1,
           updated_at = (
             SELECT applied_at - INTERVAL '1 second'
             FROM schema_migrations
             WHERE filename = '111_notify_and_completion_export_skills.sql'
           )
       WHERE agent_id = $2 AND skill_name = 'completion_export'`,
      [draftDestinationId, agent.id],
    );
    await database.pool.query(correctionMigrationSql);

    const [correctedSkill] = await database.query<{ target_id: string }>(
      "SELECT target_id FROM agent_skills WHERE agent_id = $1 AND skill_name = 'completion_export'",
      [agent.id],
    );
    expect(correctedSkill).toEqual({ target_id: publishedDestinationId });

    await database.execute(
      "UPDATE agent_skills SET target_id = $1, updated_at = NOW() WHERE agent_id = $2 AND skill_name = 'completion_export'",
      [userEditedDestinationId, agent.id],
    );
    await database.pool.query(correctionMigrationSql);

    const [userEditedSkill] = await database.query<{ target_id: string }>(
      "SELECT target_id FROM agent_skills WHERE agent_id = $1 AND skill_name = 'completion_export'",
      [agent.id],
    );
    expect(userEditedSkill).toEqual({ target_id: userEditedDestinationId });
  });

  it("fails instead of overwriting an existing non-notify contact_human skill", async () => {
    const account = await accountRepository.create({
      name: "US4 Conflict Migration",
      email: `us4-conflict-migration-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "US4 Conflict Migration");
    const agent = await agentRepository.create(workspace.id, {
      name: "US4 Conflict Agent",
      contactRequestsEnabled: true,
    });
    const destinationId = randomUUID();
    await database.execute(
      `INSERT INTO workspace_webhook_destinations (
         id, workspace_id, name, url, secret_ciphertext, encryption_key_id
       )
       VALUES ($1, $2, 'Contact Conflict', 'https://example.test/contact-conflict', 'ciphertext', 'test-key')`,
      [destinationId, workspace.id],
    );
    await database.execute(
      `INSERT INTO agent_skills (
         id, workspace_id, agent_id, skill_name, kind, target_type, target_id, config, invocation_mode, enabled
       )
       VALUES ($1, $2, $3, 'contact_human', 'webhook', 'webhook_destination', $4, '{}'::jsonb, 'routine_named', TRUE)`,
      [randomUUID(), workspace.id, agent.id, destinationId],
    );

    await expect(database.pool.query(migration111Sql)).rejects.toThrow(/non-notify skill named "contact_human"/);

    const [row] = await database.query<{ kind: string; target_id: string }>(
      `SELECT kind, target_id FROM agent_skills WHERE agent_id = $1 AND skill_name = 'contact_human'`,
      [agent.id],
    );
    expect(row).toEqual({ kind: "webhook", target_id: destinationId });
  });
});
