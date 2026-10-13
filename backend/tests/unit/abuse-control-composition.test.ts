import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAbuseControlComposition } from "../../src/app/composition/abuseControl.js";
import { createRateLimitMiddleware } from "../../src/app/http/middleware/rateLimit.js";
import type {
  AbuseControlRepositoryPort,
} from "../../src/modules/security/contracts/abuseControl.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { InMemoryAbuseControlRepository } from "../support/fakes.js";

const trackingRepository = (): {
  consume: ReturnType<typeof vi.fn>;
  repository: AbuseControlRepositoryPort;
} => {
  const delegate = new InMemoryAbuseControlRepository();
  const consume = vi.fn(delegate.consume.bind(delegate));
  return {
    consume,
    repository: {
      find: delegate.find.bind(delegate),
      save: delegate.save.bind(delegate),
      consume,
      consumeBatch: delegate.consumeBatch.bind(delegate),
      deleteExpired: delegate.deleteExpired.bind(delegate),
    },
  };
};

describe("abuse-control composition", () => {
  it("keeps a rate-limited check entirely off Postgres when Redis is configured", async () => {
    const redis = trackingRepository();
    const postgres = trackingRepository();
    const close = vi.fn(async () => {});
    const composition = createAbuseControlComposition({
      env: {
        ABUSE_CONTROL_REDIS_COMMAND_TIMEOUT_MS: 250,
        ABUSE_CONTROL_REDIS_URL: "redis://rate-limit.test:6379",
      },
      logger: { warn: vi.fn() },
      metricsRegistry: new MetricsRegistry(),
      postgresRepository: postgres.repository,
      redisRepositoryFactory: () => ({ ...redis.repository, close }),
    });
    const auditRecord = vi.fn(async () => {});
    const app = express();
    app.get("/limited", createRateLimitMiddleware({
      service: composition.service,
      auditService: { record: auditRecord },
      scope: "auth.login",
      limit: 1,
      windowMs: 60_000,
      resolveSubjectKey: () => "redis-only",
    }), (_req, res) => res.sendStatus(204));
    app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ statusCode: error.statusCode ?? 500 });
    });

    await request(app).get("/limited").expect(204);
    await request(app).get("/limited").expect(429).expect("Retry-After", "60");

    expect(redis.consume).toHaveBeenCalledTimes(2);
    expect(postgres.consume).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "security.rate_limit_enforced",
      eventStatus: "success",
    }));
    await composition.shutdown();
    expect(close).toHaveBeenCalledOnce();
  });

  it("falls back to Postgres for a Redis error and emits low-cardinality observability", async () => {
    const postgres = trackingRepository();
    const redisDelegate = new InMemoryAbuseControlRepository();
    const warn = vi.fn();
    const metrics = new MetricsRegistry();
    const composition = createAbuseControlComposition({
      env: {
        ABUSE_CONTROL_REDIS_COMMAND_TIMEOUT_MS: 250,
        ABUSE_CONTROL_REDIS_URL: "redis://rate-limit.test:6379",
      },
      logger: { warn },
      metricsRegistry: metrics,
      postgresRepository: postgres.repository,
      redisRepositoryFactory: () => ({
        find: redisDelegate.find.bind(redisDelegate),
        save: redisDelegate.save.bind(redisDelegate),
        close: async () => {},
        consume: async () => {
          throw new Error("Redis command timed out");
        },
        consumeBatch: redisDelegate.consumeBatch.bind(redisDelegate),
        deleteExpired: redisDelegate.deleteExpired.bind(redisDelegate),
      }),
    });

    await expect(composition.service.enforce({
      scope: "auth.login",
      subjectKey: "fallback",
      limit: 2,
      windowMs: 60_000,
      now: new Date("2026-10-13T10:00:00.000Z"),
    })).resolves.toMatchObject({ remaining: 1 });

    expect(postgres.consume).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        component: "abuse-control",
        operation: "consume",
        primaryStore: "redis",
        fallbackStore: "postgres",
      },
      "abuse_control_store_fallback",
    );
    expect(metrics.renderPrometheus()).toContain(
      'radioso_abuse_control_store_fallback_total{operation="consume"} 1',
    );
  });

  it("falls back as one Postgres batch when the Redis batch command errors", async () => {
    const postgres = trackingRepository();
    const redisDelegate = new InMemoryAbuseControlRepository();
    const warn = vi.fn();
    const composition = createAbuseControlComposition({
      env: {
        ABUSE_CONTROL_REDIS_COMMAND_TIMEOUT_MS: 250,
        ABUSE_CONTROL_REDIS_URL: "redis://rate-limit.test:6379",
      },
      logger: { warn },
      metricsRegistry: null,
      postgresRepository: postgres.repository,
      redisRepositoryFactory: () => ({
        find: redisDelegate.find.bind(redisDelegate),
        save: redisDelegate.save.bind(redisDelegate),
        close: async () => {},
        consume: redisDelegate.consume.bind(redisDelegate),
        consumeBatch: async () => {
          throw new Error("Redis unavailable");
        },
        deleteExpired: redisDelegate.deleteExpired.bind(redisDelegate),
      }),
    });

    await expect(composition.service.enforceBatch([
      { scope: "agent.grant", subjectKey: "grant", limit: 2, windowMs: 60_000 },
      { scope: "agent.workspace", subjectKey: "workspace", limit: 3, windowMs: 60_000 },
    ])).resolves.toHaveLength(2);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "consume_batch" }),
      "abuse_control_store_fallback",
    );
    expect(await postgres.repository.find("agent.grant", "grant")).not.toBeNull();
  });

  it("uses Postgres directly when the Redis switch is absent", async () => {
    const postgres = trackingRepository();
    const redisRepositoryFactory = vi.fn();
    const composition = createAbuseControlComposition({
      env: {
        ABUSE_CONTROL_REDIS_COMMAND_TIMEOUT_MS: 250,
        ABUSE_CONTROL_REDIS_URL: undefined,
      },
      logger: { warn: vi.fn() },
      metricsRegistry: null,
      postgresRepository: postgres.repository,
      redisRepositoryFactory,
    });

    await composition.service.enforce({
      scope: "auth.login",
      subjectKey: "postgres-default",
      limit: 2,
      windowMs: 60_000,
      now: new Date("2026-10-13T10:00:00.000Z"),
    });

    expect(postgres.consume).toHaveBeenCalledOnce();
    expect(redisRepositoryFactory).not.toHaveBeenCalled();
  });
});
