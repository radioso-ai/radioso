import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import type { Env } from "../../src/app/config/env.js";
import { buildRoutineOperatorReachReader } from "../../src/app/composition/contactDelivery.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { NotificationRecipientStateRepository } from "../../src/db/repositories/notificationRecipientStateRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const env = {
  NOTIFICATION_RECIPIENT_CONFIRMATION_ENABLED: true,
  SESSION_COOKIE_SECRET: "integration-session-cookie-secret",
  PORT: 8080,
} as Env;

/** The check production composes, over a real database: what is stored decides, and reading stores nothing. */
describeIntegration("routine operator reach (Postgres)", () => {
  const databaseName = `routine_operator_reach_${randomUUID().replaceAll("-", "")}_test`;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const mailer = { send: vi.fn(async () => ({ dispatched: true, skipReason: null })) };
  let database: Database;
  let states: NotificationRecipientStateRepository;
  let agentId: string;

  const reach = () => buildRoutineOperatorReachReader({
    database,
    env,
    mailer,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    metrics: null,
  }).forAgent({ workspaceId, agentId });

  const confirm = async (email: string): Promise<void> => {
    const { recipientId, generation } = await states.ensure(workspaceId, email);
    await states.confirm(recipientId, generation, new Date());
  };

  const storedRecipientCount = async (): Promise<number> => {
    const rows = await database.query<{ count: string }>(
      "SELECT count(*) AS count FROM notification_recipient_confirmations WHERE workspace_id = $1",
      [workspaceId],
    );
    return Number(rows[0]?.count ?? 0);
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    } finally {
      await admin.end();
    }
    const url = new URL(integrationDatabaseUrl);
    url.pathname = `/${databaseName}`;
    url.searchParams.delete("options");
    database = new Database(url.toString());
    await runAllTestMigrations(database);
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Acme", `account-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Acme workspace", `acme-${randomUUID()}`],
    );
    states = new NotificationRecipientStateRepository(database.kysely);
    const agent = await new AgentRepository(database.kysely).create(workspaceId, {
      name: "Front desk",
      contactRequestDelivery: { recipientEmails: ["reception@example.com"], webhook: null },
    });
    agentId = agent.id;
    const skills = new AgentSkillRepository(database.kysely);
    await skills.create({
      workspaceId,
      agentId,
      skillName: "notify_bookings",
      kind: "notify",
      invocationMode: "routine_named",
      config: { delivery: { recipientEmails: ["bookings@example.com"], webhook: null } },
    });
    await skills.create({
      workspaceId,
      agentId,
      skillName: "notify_webhook",
      kind: "notify",
      invocationMode: "routine_named",
      config: { delivery: { recipientEmails: ["bookings@example.com"], webhook: { url: "https://hooks.example.com/bookings" } } },
    });
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("finds nobody for an address that never confirmed, and leaves no trace of having asked", async () => {
    const before = await storedRecipientCount();

    await expect(reach().canReachOperators({ terminal: { kind: "complete", stepId: "done", operatorNotice: {} } }))
      .resolves.toBe(false);
    await expect(reach().canReachOperators({ actions: [{ type: "contact.send", payload: {} }] }))
      .resolves.toBe(false);

    expect(await storedRecipientCount()).toBe(before);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("finds a webhook on the route the ending names, whatever its addresses' state", async () => {
    await expect(reach().canReachOperators({
      terminal: { kind: "complete", stepId: "done", operatorNotice: { skillName: "notify_webhook" } },
    })).resolves.toBe(true);
  });

  it("reads a notify skill step's own route, from the skill's stored kind", async () => {
    await expect(reach().canReachOperators({ skillsWithExternalEffects: ["notify_bookings"] })).resolves.toBe(false);
    await expect(reach().canReachOperators({ skillsWithExternalEffects: ["no_such_skill"] })).resolves.toBe(true);
  });

  it("follows the confirmation: the default route reaches someone once its address confirms, the named one still does not", async () => {
    await confirm("reception@example.com");

    await expect(reach().canReachOperators({ terminal: { kind: "complete", stepId: "done", operatorNotice: {} } }))
      .resolves.toBe(true);
    await expect(reach().canReachOperators({
      terminal: { kind: "complete", stepId: "done", operatorNotice: { skillName: "notify_bookings" } },
    })).resolves.toBe(false);

    expect(mailer.send).not.toHaveBeenCalled();
  });
});
