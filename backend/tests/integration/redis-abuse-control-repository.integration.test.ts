import { createHash, randomUUID } from "node:crypto";
import net from "node:net";

import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AbuseControlRepository } from "../../src/db/repositories/abuseControlRepository.js";
import { FallbackAbuseControlRepository } from "../../src/modules/security/infrastructure/fallbackAbuseControlRepository.js";
import { RedisAbuseControlRepository } from "../../src/modules/security/infrastructure/redisAbuseControlRepository.js";
import { AbuseControlService } from "../../src/modules/security/services/abuseControlService.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const redisUrl = process.env.ABUSE_CONTROL_TEST_REDIS_URL;
if (!redisUrl && process.env.CI) {
  throw new Error("ABUSE_CONTROL_TEST_REDIS_URL must be configured for Redis integration coverage in CI");
}
if (!redisUrl) {
  process.stderr.write("Skipping Redis abuse-control integration tests: ABUSE_CONTROL_TEST_REDIS_URL is not configured.\n");
}
const describeRedis = redisUrl ? describe : describe.skip;
const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();
const describeRedisIntegration = redisUrl && integrationDatabaseUrl ? describeIntegration : describe.skip;
const ENTRY_TTL_MS = 24 * 60 * 60 * 1_000;

const redisEntryKey = (scope: string, subjectKey: string): string => {
  const digest = createHash("sha256").update(scope).update("\0").update(subjectKey).digest("hex");
  return `radioso:abuse-control:v1:${digest}`;
};

const startBlackholeRedis = async (): Promise<{ close(): Promise<void>; url: string }> => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Blackhole Redis server did not bind a TCP address");
  return {
    url: `redis://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describeRedis("RedisAbuseControlRepository", () => {
  const repository = new RedisAbuseControlRepository({
    commandTimeoutMs: 1_000,
    redisUrl: redisUrl ?? "redis://127.0.0.1:6379",
  });
  const service = new AbuseControlService(repository);
  const scope = `test.abuse-control.${randomUUID()}`;
  const rawRedis = createClient({ url: redisUrl ?? "redis://127.0.0.1:6379" });

  beforeAll(async () => {
    rawRedis.on("error", () => undefined);
    await rawRedis.connect();
  });
  afterAll(async () => {
    await repository.close();
    await rawRedis.close();
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

    const decision = await service.enforce({
      scope: `${scope}.decision`,
      subjectKey: "same-subject",
      limit: 5,
      windowMs: 60_000,
      now,
    });
    const entry = await repository.find(`${scope}.decision`, "same-subject");
    expect(decision).toEqual({
      limit: 5,
      remaining: 4,
      resetAtMs: entry!.windowStartedAt.getTime() + 60_000,
    });
  });

  it("does not admit a second allowance across a rolling-window boundary", async () => {
    const windowMs = 200;
    const policy = {
      scope: `${scope}.boundary`,
      subjectKey: "same-subject",
      limit: 1,
      windowMs,
    };

    await service.enforce(policy);
    await new Promise((resolve) => setTimeout(resolve, windowMs + 25));

    await expect(
      service.enforce(policy),
    ).rejects.toMatchObject({ statusCode: 429, code: "rate_limit_exceeded" });

    const entry = await repository.find(policy.scope, policy.subjectKey);
    expect(entry).toMatchObject({ attemptCount: 1, previousAttemptCount: 1 });

    const separateScope = `${scope}.boundary.separate`;
    await service.enforce({ ...policy, scope: separateScope });
    await new Promise((resolve) => setTimeout(resolve, 2 * windowMs + 25));
    await expect(service.enforce({ ...policy, scope: separateScope })).resolves.toMatchObject({ remaining: 0 });
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
        resetAtMs: expect.any(Number),
        retryAfterSeconds: 15,
      },
    });

    expect(await repository.find(blockedScope, "grant")).toBeNull();
    expect((await repository.find(blockedScope, "workspace"))?.attemptCount).toBe(1);
  });

  it("sets and extends Redis TTLs for saves, admissions, rejections, and batch writes", async () => {
    const ttlScope = `${scope}.ttl`;
    const savedKey = redisEntryKey(ttlScope, "saved");
    await repository.save({
      scope: ttlScope,
      subjectKey: "saved",
      attemptCount: 1,
      windowStartedAt: new Date(),
      blockedUntil: null,
    });
    expect(await rawRedis.pTTL(savedKey)).toBeGreaterThan(ENTRY_TTL_MS - 10_000);

    const admissionKey = redisEntryKey(ttlScope, "admission");
    await repository.consume({
      scope: ttlScope,
      subjectKey: "admission",
      limit: 2,
      windowMs: 60_000,
      blockMs: 60_000,
      now: new Date(),
    });
    expect(await rawRedis.pTTL(admissionKey)).toBeGreaterThan(ENTRY_TTL_MS - 10_000);

    const blockedKey = redisEntryKey(ttlScope, "blocked");
    const longBlockMs = ENTRY_TTL_MS + 30_000;
    const blockedInput = {
      scope: ttlScope,
      subjectKey: "blocked",
      limit: 1,
      windowMs: 60_000,
      blockMs: longBlockMs,
      now: new Date(),
    };
    await repository.consume(blockedInput);
    expect((await repository.consume(blockedInput)).blocked).toBe(true);
    expect(await rawRedis.pTTL(blockedKey)).toBeGreaterThan(ENTRY_TTL_MS + 10_000);

    const batch = await repository.consumeBatch([
      { scope: ttlScope, subjectKey: "batch-one", limit: 2, windowMs: 60_000, blockMs: 60_000, now: new Date() },
      { scope: ttlScope, subjectKey: "batch-two", limit: 2, windowMs: 60_000, blockMs: 60_000, now: new Date() },
    ]);
    expect(batch.rejected).toBeNull();
    await expect(rawRedis.pTTL(redisEntryKey(ttlScope, "batch-one"))).resolves.toBeGreaterThan(ENTRY_TTL_MS - 10_000);
    await expect(rawRedis.pTTL(redisEntryKey(ttlScope, "batch-two"))).resolves.toBeGreaterThan(ENTRY_TTL_MS - 10_000);
  });

  it("uses Redis time for the returned decision clock", async () => {
    const serverTime = await rawRedis.time();
    const serverNowMs = Number(serverTime[0]) * 1_000 + Math.floor(Number(serverTime[1]) / 1_000);
    const result = await repository.consume({
      scope: `${scope}.clock`,
      subjectKey: "same-subject",
      limit: 5,
      windowMs: 60_000,
      blockMs: 60_000,
      now: new Date("2000-01-01T00:00:00.000Z"),
    });

    expect(result.evaluatedAt.getTime()).toBeGreaterThanOrEqual(serverNowMs);
    expect(result.evaluatedAt.getTime()).toBeLessThan(serverNowMs + 5_000);
    expect(result.entry.windowStartedAt.getTime()).toBe(result.evaluatedAt.getTime());
  });
});

describeRedisIntegration("Redis abuse-control failover and semantic parity", () => {
  const database = new Database(integrationDatabaseUrl);
  const postgres = new AbuseControlRepository(database.kysely);
  const scope = `test.abuse-control.redis-review.${randomUUID()}`;

  afterAll(async () => {
    await database.query("DELETE FROM abuse_control_entries WHERE scope LIKE $1", [`${scope}%`]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("falls back to Postgres within the command deadline when Redis accepts but never replies", async () => {
    const blackhole = await startBlackholeRedis();
    const deadlineMs = 100;
    const redis = new RedisAbuseControlRepository({ redisUrl: blackhole.url, commandTimeoutMs: deadlineMs });
    const repository = new FallbackAbuseControlRepository(redis, postgres, {
      logger: { warn: () => undefined },
    });
    const service = new AbuseControlService(repository);
    const fallbackScope = `${scope}.blackhole`;
    const startedAt = Date.now();
    try {
      await expect(service.enforce({
        scope: fallbackScope,
        subjectKey: "same-subject",
        limit: 2,
        windowMs: 60_000,
      })).resolves.toMatchObject({ remaining: 1 });
      expect(Date.now() - startedAt).toBeLessThan(deadlineMs + 200);
      expect(await postgres.find(fallbackScope, "same-subject")).not.toBeNull();
    } finally {
      await redis.close();
      await blackhole.close();
    }
  });

  it("returns equivalent admission decisions for the same single and batch vectors", async () => {
    const postgresService = new AbuseControlService(postgres);
    const redis = new RedisAbuseControlRepository({ redisUrl: redisUrl!, commandTimeoutMs: 1_000 });
    const redisService = new AbuseControlService(redis);
    const vectorScope = `${scope}.differential`;
    const compare = async (subjectKey: string, limit: number) => {
      const now = new Date();
      const [postgresResult, redisResult] = await Promise.allSettled([
        postgresService.enforce({ scope: vectorScope, subjectKey, limit, windowMs: 60_000, blockMs: 30_000, now }),
        redisService.enforce({ scope: vectorScope, subjectKey, limit, windowMs: 60_000, blockMs: 30_000, now }),
      ]);
      const normalize = (result: PromiseSettledResult<{ limit: number; remaining: number }>) => result.status === "fulfilled"
        ? { kind: "admitted", limit: result.value.limit, remaining: result.value.remaining }
        : {
          kind: "blocked",
          limit: (result.reason as { details: { limit: number } }).details.limit,
          remaining: (result.reason as { details: { remaining: number } }).details.remaining,
        };
      expect(normalize(redisResult)).toEqual(normalize(postgresResult));
    };

    await compare("single", 2);
    await compare("single", 2);
    await compare("single", 2);
    const now = new Date();
    const batchPolicies = [
      { scope: vectorScope, subjectKey: "batch-one", limit: 2, windowMs: 60_000, blockMs: 30_000, now },
      { scope: vectorScope, subjectKey: "batch-two", limit: 2, windowMs: 60_000, blockMs: 30_000, now },
    ];
    const [postgresBatch, redisBatch] = await Promise.all([
      postgresService.enforceBatch(batchPolicies),
      redisService.enforceBatch(batchPolicies),
    ]);
    expect(redisBatch.map(({ limit, remaining }) => ({ limit, remaining }))).toEqual(
      postgresBatch.map(({ limit, remaining }) => ({ limit, remaining })),
    );
    await redis.close();
  });
});
