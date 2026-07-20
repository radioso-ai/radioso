import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_DIRECTIVE_STATE_TTL_MS,
  DirectiveStateRepository,
} from "../../src/db/repositories/directiveStateRepository.js";
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

describeIfDatabase("directive state persistence (#865)", () => {
  let database: Database;
  let repository: DirectiveStateRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    repository = new DirectiveStateRepository(database.kysely);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
  });

  it("returns null before any turn commits firing memory", async () => {
    expect(await repository.load({ sessionId: randomUUID() })).toBeNull();
  });

  it("upserts and advances the per-conversation firing state across turns", async () => {
    const sessionId = randomUUID();

    await repository.save({
      sessionId,
      state: { turnSeq: 1, firings: { intro: { lastFiredTurn: 0, count: 1 } } },
    });
    expect(await repository.load({ sessionId })).toEqual({
      turnSeq: 1,
      firings: { intro: { lastFiredTurn: 0, count: 1 } },
    });

    // A later turn upserts the same row with the advanced sequence and a new firing.
    await repository.save({
      sessionId,
      state: {
        turnSeq: 2,
        firings: { intro: { lastFiredTurn: 0, count: 1 }, nudge: { lastFiredTurn: 1, count: 1 } },
      },
    });
    expect(await repository.load({ sessionId })).toEqual({
      turnSeq: 2,
      firings: { intro: { lastFiredTurn: 0, count: 1 }, nudge: { lastFiredTurn: 1, count: 1 } },
    });

    await database.query("DELETE FROM directive_states WHERE session_id = $1", [sessionId]);
  });

  it("does not return an expired conversation's firing memory", async () => {
    const sessionId = randomUUID();
    const shortTtl = new DirectiveStateRepository(database.kysely, -1);
    await shortTtl.save({ sessionId, state: { turnSeq: 5, firings: {} } });
    expect(await repository.load({ sessionId })).toBeNull();
    await database.query("DELETE FROM directive_states WHERE session_id = $1", [sessionId]);
  });

  it("exposes a sane default TTL", () => {
    expect(DEFAULT_DIRECTIVE_STATE_TTL_MS).toBeGreaterThan(60 * 60 * 1000);
  });
});
