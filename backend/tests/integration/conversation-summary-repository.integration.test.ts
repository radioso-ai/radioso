import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConversationSummaryRepository } from "../../src/db/repositories/conversationSummaryRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

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
const expiredSummaryTtlMs = -60_000;

describeIfDatabase("conversation summary persistence (#866)", () => {
  let database: Database;
  let repository: ConversationSummaryRepository;
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  // Summaries hold conversation content, so they FK-cascade with their
  // conversation; every summary row needs a real conversation fixture.
  const createConversation = async (): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)`,
      [conversationId, workspaceId],
    );
    return conversationId;
  };

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    repository = new ConversationSummaryRepository(database.kysely);
    await runAllTestMigrations(database);
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Summary Test Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Summary Workspace", `route-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database?.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database?.close().catch(() => undefined);
  });

  it("returns null before any summary is written", async () => {
    expect(await repository.load({ sessionId: randomUUID() })).toBeNull();
  });

  it("upserts and advances the summary across turns", async () => {
    const sessionId = await createConversation();
    const coveredThrough = new Date("2026-01-01T00:00:00.000Z");

    await repository.save({
      sessionId,
      summary: { summary: "First summary.", coveredMessageCount: 10, coveredThrough },
    });
    expect(await repository.load({ sessionId })).toMatchObject({
      summary: "First summary.",
      coveredMessageCount: 10,
    });

    await repository.save({
      sessionId,
      summary: { summary: "Second summary.", coveredMessageCount: 12, coveredThrough: new Date("2026-01-02T00:00:00.000Z") },
    });
    expect(await repository.load({ sessionId })).toMatchObject({
      summary: "Second summary.",
      coveredMessageCount: 12,
    });
  });

  it("does not let a lower-watermark write clobber a newer summary", async () => {
    const sessionId = await createConversation();
    const coveredThrough = new Date("2026-01-01T00:00:00.000Z");

    await repository.save({
      sessionId,
      summary: { summary: "Newer, covers more.", coveredMessageCount: 20, coveredThrough },
    });
    // An older in-flight regeneration with fewer covered messages must not win.
    await repository.save({
      sessionId,
      summary: { summary: "Older, covers fewer.", coveredMessageCount: 14, coveredThrough },
    });

    expect(await repository.load({ sessionId })).toMatchObject({
      summary: "Newer, covers more.",
      coveredMessageCount: 20,
    });
  });

  it("does not return an expired summary", async () => {
    const sessionId = await createConversation();
    const expired = new ConversationSummaryRepository(database.kysely, expiredSummaryTtlMs);
    await expired.save({
      sessionId,
      summary: { summary: "Stale.", coveredMessageCount: 10, coveredThrough: new Date() },
    });
    expect(await repository.load({ sessionId })).toBeNull();
  });

  it("lets a fresh save overwrite an expired row regardless of its watermark", async () => {
    const sessionId = await createConversation();
    const expired = new ConversationSummaryRepository(database.kysely, expiredSummaryTtlMs);
    // Expired row with a HIGHER watermark must never block future saves: load()
    // hides it, so leaving it in place would silently black-hole every write.
    await expired.save({
      sessionId,
      summary: { summary: "Expired, covered many.", coveredMessageCount: 40, coveredThrough: new Date() },
    });
    await repository.save({
      sessionId,
      summary: { summary: "Fresh restart.", coveredMessageCount: 12, coveredThrough: new Date() },
    });
    expect(await repository.load({ sessionId })).toMatchObject({
      summary: "Fresh restart.",
      coveredMessageCount: 12,
    });
  });

  it("cascades away with its conversation", async () => {
    const sessionId = await createConversation();
    await repository.save({
      sessionId,
      summary: { summary: "Content to reclaim.", coveredMessageCount: 10, coveredThrough: new Date() },
    });
    await database.query(`DELETE FROM conversations WHERE id = $1`, [sessionId]);
    const rows = await database.query(
      `SELECT 1 FROM conversation_summaries WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows.length).toBe(0);
  });
});
