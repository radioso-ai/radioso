import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { testMigrationsPath } from "../support/databaseMigrations.js";

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

const describeIfDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("notify and completion-export skill migration", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let agentRepository: AgentRepository;
  let routineRepository: RoutineDefinitionRepository;
  let migrationSql: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database);
    workspaceRepository = new WorkspaceRepository(database);
    agentRepository = new AgentRepository(database);
    routineRepository = new RoutineDefinitionRepository(database);
    migrationSql = await readFile(path.join(testMigrationsPath, "111_notify_and_completion_export_skills.sql"), "utf8");
  });

  afterAll(async () => {
    await database.close();
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
    await routineRepository.createDraft(agent.id, {
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

    await database.pool.query(migrationSql);
    await database.pool.query(migrationSql);

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
});
