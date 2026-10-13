import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { RedisAbuseControlRepository } from "../../src/modules/security/infrastructure/redisAbuseControlRepository.js";
import { AbuseControlService } from "../../src/modules/security/services/abuseControlService.js";

const redisUrl = process.env.ABUSE_CONTROL_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis("RedisAbuseControlRepository", () => {
  const repository = new RedisAbuseControlRepository({
    commandTimeoutMs: 1_000,
    redisUrl: redisUrl ?? "redis://127.0.0.1:6379",
  });
  const service = new AbuseControlService(repository);
  const scope = `test.abuse-control.${randomUUID()}`;

  afterAll(async () => {
    await repository.close();
  });

  it("save upserts one keyed entry and find maps it back", async () => {
    const windowStartedAt = new Date();
    const blockedUntil = new Date(windowStartedAt.getTime() + 30_000);

    await repository.save({
      scope: `${scope}.save`,
      subjectKey: "same-subject",
      attemptCount: 2,
      windowStartedAt,
      blockedUntil,
    });
    await repository.save({
      scope: `${scope}.save`,
      subjectKey: "same-subject",
      attemptCount: 4,
      windowStartedAt,
      blockedUntil: null,
    });

    expect(await repository.find(`${scope}.save`, "same-subject")).toMatchObject({
      attemptCount: 4,
      previousAttemptCount: 0,
      windowStartedAt,
      blockedUntil: null,
    });
  });

  it("admits at most the limit under a concurrent burst", async () => {
    const now = new Date();
    const requests = await Promise.allSettled(Array.from({ length: 20 }, () => service.enforce({
      scope: `${scope}.concurrent`,
      subjectKey: "same-subject",
      limit: 5,
      windowMs: 60_000,
      now,
    })));

    expect(requests.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(requests.filter((result) => result.status === "rejected")).toHaveLength(15);
  });

  it("returns the same header decision inputs as the Postgres store", async () => {
    const now = new Date();

    await expect(service.enforce({
      scope: `${scope}.decision`,
      subjectKey: "same-subject",
      limit: 5,
      windowMs: 60_000,
      now,
    })).resolves.toEqual({
      limit: 5,
      remaining: 4,
      resetAtMs: now.getTime() + 60_000,
    });
  });

  it("does not admit a second allowance across a rolling-window boundary", async () => {
    const windowStart = new Date();
    const policy = {
      scope: `${scope}.boundary`,
      subjectKey: "same-subject",
      limit: 5,
      windowMs: 60_000,
    };

    for (const offsetMs of [0, 59_000, 59_100, 59_200, 59_300]) {
      await service.enforce({ ...policy, now: new Date(windowStart.getTime() + offsetMs) });
    }

    await expect(
      service.enforce({ ...policy, now: new Date(windowStart.getTime() + 61_000) }),
    ).rejects.toMatchObject({ statusCode: 429, code: "rate_limit_exceeded" });

    const entry = await repository.find(policy.scope, policy.subjectKey);
    expect(entry).toMatchObject({ attemptCount: 1, previousAttemptCount: 5 });

    const separateScope = `${scope}.boundary.separate`;
    for (const offsetMs of [0, 59_000, 59_100, 59_200, 59_300]) {
      await service.enforce({ ...policy, scope: separateScope, now: new Date(windowStart.getTime() + offsetMs) });
    }
    await expect(service.enforce({
      ...policy,
      scope: separateScope,
      now: new Date(windowStart.getTime() + 180_000),
    })).resolves.toMatchObject({ remaining: 4 });
  });

  it("preserves blockMs and rolls back an atomically rejected batch", async () => {
    const now = new Date();
    const blockedScope = `${scope}.batch`;
    await service.enforce({
      scope: blockedScope,
      subjectKey: "workspace",
      limit: 1,
      windowMs: 60_000,
      blockMs: 15_000,
      now,
    });

    await expect(service.enforceBatch([
      { scope: blockedScope, subjectKey: "grant", limit: 3, windowMs: 60_000, blockMs: 15_000, now },
      { scope: blockedScope, subjectKey: "workspace", limit: 1, windowMs: 60_000, blockMs: 15_000, now },
    ])).rejects.toMatchObject({
      statusCode: 429,
      details: {
        resetAtMs: now.getTime() + 15_000,
        retryAfterSeconds: 15,
      },
    });

    expect(await repository.find(blockedScope, "grant")).toBeNull();
    expect((await repository.find(blockedScope, "workspace"))?.attemptCount).toBe(1);
  });
});
