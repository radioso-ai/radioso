import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { AbuseControlRepository } from "../../src/db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../src/modules/security/services/abuseControlService.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AbuseControlRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new AbuseControlRepository(database.kysely);
  const scope = `auth.login.${randomUUID()}`;

  afterAll(async () => {
    await database.query(`DELETE FROM abuse_control_entries WHERE scope LIKE $1`, [`${scope}%`]).catch(() => undefined);
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

  it("allows exactly one concurrent request when an atomic budget has a limit of one", async () => {
    const concurrentScope = `${scope}.concurrent`;
    const service = new AbuseControlService(repository);
    const requests = await Promise.allSettled(Array.from({ length: 20 }, () => service.enforce({
      scope: concurrentScope,
      subjectKey: "same-subject",
      limit: 1,
      windowMs: 60_000,
    })));

    expect(requests.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(requests.filter((result) => result.status === "rejected")).toHaveLength(19);
    expect((await repository.find(concurrentScope, "same-subject"))?.attemptCount).toBe(2);
  });

  it("rolls back the grant consumption when the workspace budget is unavailable", async () => {
    const batchScope = `${scope}.batch`;
    const service = new AbuseControlService(repository);
    const now = new Date();

    await service.enforce({
      scope: batchScope,
      subjectKey: "workspace:one:global",
      limit: 1,
      windowMs: 60_000,
      now,
    });

    await expect(service.enforceBatch([
      { scope: batchScope, subjectKey: "grant:one", limit: 4, windowMs: 60_000, now },
      { scope: batchScope, subjectKey: "workspace:one:global", limit: 1, windowMs: 60_000, now },
    ])).rejects.toMatchObject({ statusCode: 429, code: "rate_limit_exceeded" });

    expect(await repository.find(batchScope, "grant:one")).toBeNull();
    expect((await repository.find(batchScope, "workspace:one:global"))?.attemptCount).toBe(1);
  });
});
