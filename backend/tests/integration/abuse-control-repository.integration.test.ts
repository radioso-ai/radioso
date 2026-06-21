import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { AbuseControlRepository } from "../../src/db/repositories/abuseControlRepository.js";
import { Database } from "../../src/shared/infra/database.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
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

const describeIfDatabase = (await canReach(integrationDatabaseUrl)) ? describe : describe.skip;

describeIfDatabase("AbuseControlRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new AbuseControlRepository(database.kysely);
  const scope = `auth.login.${randomUUID()}`;

  afterAll(async () => {
    await database.query(`DELETE FROM abuse_control_entries WHERE scope = $1`, [scope]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("save upserts on (scope, subject_key) and find returns the entry", async () => {
    const windowStartedAt = new Date("2026-03-30T10:00:00.000Z");
    const saved = await repository.save({
      scope,
      subjectKey: "alice",
      attemptCount: 2,
      windowStartedAt,
      blockedUntil: new Date("2026-03-30T10:01:00.000Z"),
    });
    expect(saved.attemptCount).toBe(2);

    const updated = await repository.save({
      scope,
      subjectKey: "alice",
      attemptCount: 5,
      windowStartedAt,
      blockedUntil: null,
    });
    expect(updated.attemptCount).toBe(5);
    expect(updated.blockedUntil).toBeNull();
    expect(updated.createdAt.getTime()).toBe(saved.createdAt.getTime());

    expect((await repository.find(scope, "alice"))?.attemptCount).toBe(5);
    expect(await repository.find(scope, "missing")).toBeNull();
  });

  it("deleteExpired removes past blocks and stale windows, keeping active ones", async () => {
    const now = new Date("2026-03-30T12:00:00.000Z");
    // expired block
    await repository.save({ scope, subjectKey: "blocked-old", attemptCount: 1, windowStartedAt: now, blockedUntil: new Date("2026-03-30T11:00:00.000Z") });
    // active block (future)
    await repository.save({ scope, subjectKey: "blocked-future", attemptCount: 1, windowStartedAt: now, blockedUntil: new Date("2026-03-30T13:00:00.000Z") });
    // stale window, no block (>24h old)
    await repository.save({ scope, subjectKey: "stale", attemptCount: 1, windowStartedAt: new Date("2026-03-28T00:00:00.000Z"), blockedUntil: null });
    // fresh window, no block
    await repository.save({ scope, subjectKey: "fresh", attemptCount: 1, windowStartedAt: now, blockedUntil: null });

    await repository.deleteExpired(now);

    expect(await repository.find(scope, "blocked-old")).toBeNull();
    expect(await repository.find(scope, "stale")).toBeNull();
    expect(await repository.find(scope, "blocked-future")).not.toBeNull();
    expect(await repository.find(scope, "fresh")).not.toBeNull();
  });
});
