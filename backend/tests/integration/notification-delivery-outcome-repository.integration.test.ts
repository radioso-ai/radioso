import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { NotificationDeliveryOutcomeRepository } from "../../src/db/repositories/notificationDeliveryOutcomeRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { seedConversations } from "./support/conversationSeed.js";
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

  /** An outcome names the conversation whose notice it admitted. */
  const newConversation = async (): Promise<string> => {
    const conversationId = randomUUID();
    await seedConversations(database, [conversationId]);
    return conversationId;
  };

  const reserve = async (overrides: Partial<Parameters<NotificationDeliveryOutcomeRepository["reserve"]>[0]> = {}) =>
    repository.reserve({
      requestId: randomUUID(),
      workspaceId: randomUUID(),
      conversationId: overrides.conversationId ?? await newConversation(),
      usageDate: new Date("2026-10-11T00:00:00.000Z"),
      recipientDigest: "recipient-set-default",
      requestedEmailCount: 1,
      dailyEmailLimit: 100,
      conversationDispatchLimit: 5,
      ...overrides,
    });

  it("atomically admits only the conversation dispatch allowance under concurrency", async () => {
    const workspaceId = randomUUID();
    const conversationId = await newConversation();
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
      requestedEmailCount: 1,
      dailyEmailLimit: 5,
      conversationDispatchLimit: 5,
    })));

    expect(outcomes.filter((outcome) => outcome.emailAllowed)).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome.reason === "workspace_daily_email_cap")).toHaveLength(7);
  });

  it("reads a workspace's emails sent today and how many requests the daily cap stopped", async () => {
    const workspaceId = randomUUID();
    await reserve({ workspaceId, requestedEmailCount: 2, dailyEmailLimit: 3 });
    await reserve({ workspaceId, requestedEmailCount: 2, dailyEmailLimit: 3 });
    await reserve({ workspaceId: randomUUID(), requestedEmailCount: 1, dailyEmailLimit: 3 });

    await expect(repository.readDailyUsage({ workspaceId, usageDate: new Date("2026-10-11T00:00:00.000Z") }))
      .resolves.toEqual({ reservedEmails: 2, cappedRequests: 1 });
    await expect(repository.readDailyUsage({ workspaceId, usageDate: new Date("2026-10-12T00:00:00.000Z") }))
      .resolves.toEqual({ reservedEmails: 0, cappedRequests: 0 });
  });

  it("reserves the extra emails a replay can now send, and caps a replay that would exceed the day", async () => {
    const workspaceId = randomUUID();
    const conversationId = await newConversation();
    const requestId = randomUUID();
    const first = await reserve({ requestId, workspaceId, conversationId, requestedEmailCount: 0, dailyEmailLimit: 4 });
    const toppedUp = await reserve({ requestId, workspaceId, conversationId, requestedEmailCount: 3, dailyEmailLimit: 4 });

    expect(first).toMatchObject({ emailAllowed: true, newlyRecorded: true });
    expect(toppedUp).toMatchObject({ dispatchAllowed: true, emailAllowed: true, newlyRecorded: false });
    await expect(repository.readDailyUsage({ workspaceId, usageDate: new Date("2026-10-11T00:00:00.000Z") }))
      .resolves.toMatchObject({ reservedEmails: 3 });

    const otherRequest = randomUUID();
    await reserve({ requestId: otherRequest, workspaceId, requestedEmailCount: 0, dailyEmailLimit: 4 });
    const overLimit = await reserve({ requestId: otherRequest, workspaceId, requestedEmailCount: 2, dailyEmailLimit: 4 });

    expect(overLimit).toMatchObject({ dispatchAllowed: true, emailAllowed: false, reason: "workspace_daily_email_cap" });
    await expect(repository.readDailyUsage({ workspaceId, usageDate: new Date("2026-10-11T00:00:00.000Z") }))
      .resolves.toMatchObject({ reservedEmails: 3 });
  });

  it("reserves recipient attempts atomically and replays the same request without double counting", async () => {
    const workspaceId = randomUUID();
    const conversationId = await newConversation();
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

  it("counts a recipient-set change on a replay as a new admission", async () => {
    const workspaceId = randomUUID();
    const conversationId = await newConversation();
    const requestId = randomUUID();

    const first = await reserve({
      requestId,
      workspaceId,
      conversationId,
      recipientDigest: "recipient-set-before-change",
      requestedEmailCount: 2,
      dailyEmailLimit: 3,
    });
    const rotatedRecipientReplay = await reserve({
      requestId,
      workspaceId,
      conversationId,
      recipientDigest: "recipient-set-after-change",
      requestedEmailCount: 2,
      dailyEmailLimit: 3,
    });

    expect(first).toMatchObject({ dispatchAllowed: true, emailAllowed: true, reason: null, newlyRecorded: true });
    expect(rotatedRecipientReplay).toMatchObject({
      dispatchAllowed: true,
      emailAllowed: false,
      reason: "workspace_daily_email_cap",
      newlyRecorded: true,
    });
  });
});
