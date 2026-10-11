import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { NotificationDeliveryOutcomeRepository } from "../../src/db/repositories/notificationDeliveryOutcomeRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("NotificationDeliveryOutcomeRepository (Postgres)", () => {
  const testDatabaseName = `notification_delivery_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
  let repository: NotificationDeliveryOutcomeRepository;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`CREATE DATABASE "${testDatabaseName}" TEMPLATE template0`);
    } finally {
      await admin.end();
    }

    const testDatabaseUrl = new URL(integrationDatabaseUrl);
    testDatabaseUrl.pathname = `/${testDatabaseName}`;
    testDatabaseUrl.searchParams.delete("options");
    database = new Database(testDatabaseUrl.toString());
    await runAllTestMigrations(database);
    repository = new NotificationDeliveryOutcomeRepository(database.kysely);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  const reserve = (overrides: Partial<Parameters<NotificationDeliveryOutcomeRepository["reserve"]>[0]> = {}) =>
    repository.reserve({
      requestId: randomUUID(),
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
      usageDate: new Date("2026-10-11T00:00:00.000Z"),
      requestedEmailCount: 1,
      dailyEmailLimit: 100,
      conversationDispatchLimit: 5,
      ...overrides,
    });

  it("atomically admits only the conversation dispatch allowance under concurrency", async () => {
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => reserve({
      workspaceId,
      conversationId,
      dailyEmailLimit: 100,
      conversationDispatchLimit: 5,
    })));

    expect(outcomes.filter((outcome) => outcome.dispatchAllowed)).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome.reason === "conversation_dispatch_cap")).toHaveLength(7);
  });

  it("atomically reserves only the workspace daily email allowance under concurrency", async () => {
    const workspaceId = randomUUID();
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => reserve({
      workspaceId,
      conversationId: randomUUID(),
      requestedEmailCount: 1,
      dailyEmailLimit: 5,
      conversationDispatchLimit: 5,
    })));

    expect(outcomes.filter((outcome) => outcome.emailAllowed)).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome.reason === "workspace_daily_email_cap")).toHaveLength(7);
  });

  it("reserves recipient attempts atomically and replays the same request without double counting", async () => {
    const workspaceId = randomUUID();
    const conversationId = randomUUID();
    const requestId = randomUUID();
    const first = await reserve({ requestId, workspaceId, conversationId, requestedEmailCount: 2, dailyEmailLimit: 3 });
    const replay = await reserve({ requestId, workspaceId, conversationId, requestedEmailCount: 2, dailyEmailLimit: 3 });
    const capped = await reserve({ workspaceId, conversationId, requestedEmailCount: 2, dailyEmailLimit: 3 });

    expect(first).toMatchObject({ dispatchAllowed: true, emailAllowed: true, reason: null, newlyRecorded: true });
    expect(replay).toMatchObject({ dispatchAllowed: true, emailAllowed: true, reason: null, newlyRecorded: false });
    expect(capped).toMatchObject({
      dispatchAllowed: true,
      emailAllowed: false,
      reason: "workspace_daily_email_cap",
      newlyRecorded: true,
    });
  });
});
