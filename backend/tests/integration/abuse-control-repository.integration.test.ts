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

  it("deleteExpired removes entries that can no longer weigh, keeping recent windows and active blocks", async () => {
    const now = new Date("2026-03-30T12:00:00.000Z");
    const stale = new Date("2026-03-28T00:00:00.000Z");
    // block ended, window over 24h old
    await repository.save({ scope, subjectKey: "blocked-old", attemptCount: 1, windowStartedAt: stale, blockedUntil: new Date("2026-03-30T11:00:00.000Z") });
    // block ended, window recent: its attempts still weigh on the next one
    await repository.save({ scope, subjectKey: "blocked-ended-recent", attemptCount: 4, windowStartedAt: now, blockedUntil: new Date("2026-03-30T11:00:00.000Z") });
    // active block (future), window over 24h old
    await repository.save({ scope, subjectKey: "blocked-future", attemptCount: 1, windowStartedAt: stale, blockedUntil: new Date("2026-03-30T13:00:00.000Z") });
    // stale window, no block (>24h old)
    await repository.save({ scope, subjectKey: "stale", attemptCount: 1, windowStartedAt: stale, blockedUntil: null });
    // fresh window, no block
    await repository.save({ scope, subjectKey: "fresh", attemptCount: 1, windowStartedAt: now, blockedUntil: null });

    await repository.deleteExpired(now);

    expect(await repository.find(scope, "blocked-old")).toBeNull();
    expect(await repository.find(scope, "stale")).toBeNull();
    expect(await repository.find(scope, "blocked-ended-recent")).not.toBeNull();
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
    // Each case runs on its own future day, clear of the other cases and of the real clock the
    // rest of this file's tests sweep with.
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

      await expect(service.enforce({ ...twin, now: at(610) })).rejects.toMatchObject({ statusCode: 429 });
      await expect(
        service.enforce({ ...policy, now: new Date(at(900).getTime() + 1) }),
      ).resolves.toMatchObject({ remaining: 0 });
      expect(await repository.find(policy.scope, policy.subjectKey)).toMatchObject({
        attemptCount: 1,
        previousAttemptCount: 4,
        windowStartedAt: at(600),
      });
    });

    it("admits a start a full window after the last accepted one through the batch a voice start spends", async () => {
      const at = clockOn(6);
      const voiceBatch = (now: Date) => [
        { ...voicePolicy, scope: `${scope}.gap.batch.session`, subjectKey: "workspace:session:source", now },
        { ...voicePolicy, scope: `${scope}.gap.batch.source`, subjectKey: "workspace:source", now },
        { scope: `${scope}.gap.batch.workspace`, subjectKey: "workspace:global", limit: 30, windowMs: 60_000, now },
      ];
      const visitorEntries = () => Promise.all([
        repository.find(`${scope}.gap.batch.session`, "workspace:session:source"),
        repository.find(`${scope}.gap.batch.source`, "workspace:source"),
      ]);
      for (const seconds of [0, 1, 31]) {
        await expect(service.enforceBatch(voiceBatch(at(seconds)))).resolves.toHaveLength(3);
      }

      await expect(service.enforceBatch(voiceBatch(at(546)))).rejects.toMatchObject({
        statusCode: 429,
        details: { resetAtMs: at(1_146).getTime() },
      });
      // The refused batch rolled back: both visitor budgets hold only the three accepted starts.
      for (const entry of await visitorEntries()) {
        expect(entry).toMatchObject({ attemptCount: 3, previousAttemptCount: 0, blockedUntil: null, windowStartedAt: at(0) });
      }

      await expect(service.enforceBatch(voiceBatch(at(1_156)))).resolves.toHaveLength(3);
      for (const entry of await visitorEntries()) {
        expect(entry).toMatchObject({ attemptCount: 1, previousAttemptCount: 3, windowStartedAt: at(600) });
      }
    });

    it("holds a refused limit-of-one caller until two windows have passed, past a shorter block", async () => {
      const at = clockOn(7);
      const policy = { scope: `${scope}.gap.limit-one`, subjectKey: "source", limit: 1, windowMs: 60_000, blockMs: 30_000 };
      const twin = { ...policy, subjectKey: "twin" };
      for (const subject of [policy, twin]) {
        await expect(service.enforce({ ...subject, now: at(0) })).resolves.toMatchObject({
          remaining: 0,
          resetAtMs: at(120).getTime() + 1,
        });
        await expect(service.enforce({ ...subject, now: at(10) })).rejects.toMatchObject({
          statusCode: 429,
          details: { resetAtMs: at(120).getTime() + 1, retryAfterSeconds: 111 },
        });
      }

      await expect(service.enforce({ ...twin, now: at(40) })).rejects.toMatchObject({ statusCode: 429 });
      await expect(
        service.enforce({ ...policy, now: new Date(at(120).getTime() + 1) }),
      ).resolves.toMatchObject({ remaining: 0 });
    });

    it("keeps weighing a refused caller's history once its block ends", async () => {
      const at = clockOn(5);
      const policy = { ...voicePolicy, scope: `${scope}.gap.after-block`, subjectKey: "source", blockMs: 60_000 };
      for (const seconds of [0, 1, 2]) {
        await service.enforce({ ...policy, now: at(seconds) });
      }
      await expect(service.enforce({ ...policy, now: at(10) })).rejects.toMatchObject({ statusCode: 429 });

      await repository.deleteExpired(at(80));

      expect(await repository.find(policy.scope, policy.subjectKey)).toMatchObject({ attemptCount: 4 });
      // Past the block, this attempt counts as a fifth, which holds readmission until 960 s.
      await expect(service.enforce({ ...policy, now: at(80) })).rejects.toMatchObject({
        statusCode: 429,
        details: { resetAtMs: at(960).getTime() + 1 },
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
