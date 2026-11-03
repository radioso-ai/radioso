import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

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

  it("weighs the expiring window so a burst cannot spend the budget twice across the boundary", async () => {
    const burstScope = `${scope}.burst`;
    const service = new AbuseControlService(repository);
    const windowStart = new Date("2026-03-30T10:00:00.000Z");
    const policy = { scope: burstScope, subjectKey: "same-subject", limit: 5, windowMs: 60_000 };

    for (const offsetMs of [0, 59_000, 59_100, 59_200, 59_300]) {
      await service.enforce({ ...policy, now: new Date(windowStart.getTime() + offsetMs) });
    }

    await expect(
      service.enforce({ ...policy, now: new Date(windowStart.getTime() + 61_000) }),
    ).rejects.toMatchObject({ statusCode: 429, code: "rate_limit_exceeded" });

    const entry = await repository.find(burstScope, "same-subject");
    expect(entry?.previousAttemptCount).toBe(5);
    expect(entry?.attemptCount).toBe(1);

    // A window that stands a full window clear of the last one starts from nothing.
    const separateScope = `${scope}.burst.separate`;
    for (const offsetMs of [0, 59_000, 59_100, 59_200, 59_300]) {
      await service.enforce({ ...policy, scope: separateScope, now: new Date(windowStart.getTime() + offsetMs) });
    }
    const afterGap = await service.enforce({
      ...policy,
      scope: separateScope,
      now: new Date(windowStart.getTime() + 180_000),
    });

    expect(afterGap.remaining).toBe(4);
  });

  describe("across a gap after a spent window", () => {
    const service = new AbuseControlService(repository);
    const voicePolicy = { limit: 3, windowMs: 600_000 };
    // Each case runs on its own future day, so the expiry sweep a previous case fired with its
    // own clock cannot delete this case's rows mid-run.
    const clockOn = (day: number) => (seconds: number): Date =>
      new Date(Date.UTC(2030, 0, day) + seconds * 1_000);

    it("admits a start a full window after the last accepted one", async () => {
      const at = clockOn(1);
      const policy = { ...voicePolicy, scope: `${scope}.gap.timeline`, subjectKey: "source" };
      for (const seconds of [0, 1, 31]) {
        await service.enforce({ ...policy, now: at(seconds) });
      }
      await expect(service.enforce({ ...policy, now: at(546) })).rejects.toMatchObject({
        statusCode: 429,
        details: { resetAtMs: at(1_146).getTime() },
      });

      await expect(service.enforce({ ...policy, now: at(1_156) })).resolves.toMatchObject({ remaining: 1 });
      expect(await repository.find(policy.scope, policy.subjectKey)).toMatchObject({
        attemptCount: 1,
        previousAttemptCount: 4,
        windowStartedAt: at(600),
      });
    });

    it("weighs the expired window by the share of it still inside the last window", async () => {
      const at = clockOn(2);
      const policy = { ...voicePolicy, scope: `${scope}.gap.overlap`, subjectKey: "source" };
      for (const seconds of [0, 1, 2]) {
        await service.enforce({ ...policy, now: at(seconds) });
      }

      await expect(service.enforce({ ...policy, now: at(1_010) })).resolves.toMatchObject({ remaining: 1 });
      await expect(service.enforce({ ...policy, now: at(1_010) })).resolves.toMatchObject({ remaining: 0 });
      await expect(service.enforce({ ...policy, now: at(1_010) })).rejects.toMatchObject({ statusCode: 429 });
      expect(await repository.find(policy.scope, policy.subjectKey)).toMatchObject({
        previousAttemptCount: 3,
        windowStartedAt: at(600),
      });
    });

    it("carries nothing once two windows have passed since the spent one began", async () => {
      const at = clockOn(3);
      const policy = { ...voicePolicy, scope: `${scope}.gap.clear`, subjectKey: "source" };
      for (const seconds of [0, 1, 2]) {
        await service.enforce({ ...policy, now: at(seconds) });
      }

      await expect(service.enforce({ ...policy, now: at(1_200) })).resolves.toMatchObject({ remaining: 2 });
      expect(await repository.find(policy.scope, policy.subjectKey)).toMatchObject({
        attemptCount: 1,
        previousAttemptCount: 0,
        windowStartedAt: at(1_200),
      });
    });

    it("tells a refused caller a reset at which its retry is admitted, even past the block", async () => {
      const at = clockOn(4);
      const policy = { ...voicePolicy, scope: `${scope}.gap.bunched`, subjectKey: "source" };
      const twin = { ...policy, subjectKey: "twin" };
      for (const subject of [policy, twin]) {
        for (const seconds of [0, 1, 2]) {
          await service.enforce({ ...subject, now: at(seconds) });
        }
        await expect(service.enforce({ ...subject, now: at(10) })).rejects.toMatchObject({
          statusCode: 429,
          details: { resetAtMs: at(900).getTime() + 1, retryAfterSeconds: 891 },
        });
      }

      // The repository directly, because the service's expiry sweep forgets a row whose block has
      // ended, which would admit the retry without weighing anything.
      const retry = { ...policy, blockMs: policy.windowMs };
      await expect(repository.consume({ ...retry, ...twin, now: at(610) })).resolves.toMatchObject({ blocked: true });
      const atReset = await repository.consume({ ...retry, now: new Date(at(900).getTime() + 1) });
      expect(atReset).toMatchObject({
        blocked: false,
        entry: { attemptCount: 1, previousAttemptCount: 4, windowStartedAt: at(600) },
      });
    });
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
