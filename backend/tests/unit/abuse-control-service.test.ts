import { describe, expect, it } from "vitest";

import { AbuseControlService } from "../../src/modules/security/services/abuseControlService.js";
import { InMemoryAbuseControlRepository } from "../support/fakes.js";

describe("AbuseControlService", () => {
  it("allows attempts under the limit and blocks once the limit is exceeded", async () => {
    const service = new AbuseControlService(new InMemoryAbuseControlRepository());
    const now = new Date("2026-03-30T10:00:00.000Z");

    const first = await service.enforce({
      scope: "auth.login",
      subjectKey: "alice@example.com",
      limit: 1,
      windowMs: 60_000,
      now,
    });

    expect(first.remaining).toBe(0);

    await expect(
      service.enforce({
        scope: "auth.login",
        subjectKey: "alice@example.com",
        limit: 1,
        windowMs: 60_000,
        now: new Date("2026-03-30T10:00:10.000Z"),
      }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: "rate_limit_exceeded",
      details: expect.objectContaining({
        retryAfterSeconds: expect.any(Number),
      }),
    });
  });

  it("resets the window after expiry and wraps repository failures as service_unavailable", async () => {
    const service = new AbuseControlService(new InMemoryAbuseControlRepository());

    await service.enforce({
      scope: "document.import",
      subjectKey: "workspace-1",
      limit: 1,
      windowMs: 60_000,
      now: new Date("2026-03-30T10:00:00.000Z"),
    });

    const resetAttempt = await service.enforce({
      scope: "document.import",
      subjectKey: "workspace-1",
      limit: 1,
      windowMs: 60_000,
      now: new Date("2026-03-30T10:02:00.000Z"),
    });

    expect(resetAttempt.remaining).toBe(0);

    const failingService = new AbuseControlService({
      find: async () => {
        throw new Error("db unavailable");
      },
      save: async () => {
        throw new Error("db unavailable");
      },
      consume: async () => {
        throw new Error("db unavailable");
      },
      consumeBatch: async () => ({ entries: [], rejected: null }),
      deleteExpired: async () => {},
    });

    await expect(
      failingService.enforce({
        scope: "auth.register",
        subjectKey: "bob@example.com",
        limit: 5,
        windowMs: 60_000,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "service_unavailable",
    });
  });

  it("counts the expiring window against a burst that straddles the window boundary", async () => {
    const service = new AbuseControlService(new InMemoryAbuseControlRepository());
    const policy = { scope: "public.chat.session", subjectKey: "visitor:one", limit: 5, windowMs: 60_000 };

    await service.enforce({ ...policy, now: new Date("2026-03-30T10:00:00.000Z") });
    for (const offsetMs of [59_000, 59_100, 59_200, 59_300]) {
      await service.enforce({ ...policy, now: new Date(new Date("2026-03-30T10:00:00.000Z").getTime() + offsetMs) });
    }

    await expect(
      service.enforce({ ...policy, now: new Date("2026-03-30T10:01:01.000Z") }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: "rate_limit_exceeded",
      details: expect.objectContaining({ retryAfterSeconds: expect.any(Number) }),
    });
  });

  it("reports the budget left and when it refills on the admitted path", async () => {
    const service = new AbuseControlService(new InMemoryAbuseControlRepository());
    const now = new Date("2026-03-30T10:00:00.000Z");

    const decision = await service.enforce({
      scope: "auth.login",
      subjectKey: "decision@example.com",
      limit: 5,
      windowMs: 60_000,
      now,
    });

    expect(decision).toEqual({
      limit: 5,
      remaining: 4,
      resetAtMs: now.getTime() + 60_000,
    });
  });

  it("reports the retry hint and an exhausted budget on the blocked path", async () => {
    const service = new AbuseControlService(new InMemoryAbuseControlRepository());
    const policy = { scope: "auth.login", subjectKey: "blocked@example.com", limit: 1, windowMs: 60_000, blockMs: 30_000 };
    const now = new Date("2026-03-30T10:00:00.000Z");

    await service.enforce({ ...policy, now });

    await expect(service.enforce({ ...policy, now })).rejects.toMatchObject({
      statusCode: 429,
      details: {
        limit: 1,
        remaining: 0,
        resetAtMs: now.getTime() + 30_000,
        retryAfterSeconds: 30,
      },
    });
  });

  it("consumes multiple budgets together", async () => {
    const service = new AbuseControlService(new InMemoryAbuseControlRepository());
    const now = new Date("2026-03-30T10:00:00.000Z");

    await service.enforceBatch([
      { scope: "agent.channel.chat.grant", subjectKey: "grant:one", limit: 2, windowMs: 60_000, now },
      { scope: "agent.channel.chat.workspace", subjectKey: "workspace:one:global", limit: 4, windowMs: 60_000, now },
    ]);

    await expect(service.enforceBatch([
      { scope: "agent.channel.chat.grant", subjectKey: "grant:one", limit: 2, windowMs: 60_000, now },
      { scope: "agent.channel.chat.workspace", subjectKey: "workspace:one:global", limit: 4, windowMs: 60_000, now },
    ])).resolves.toHaveLength(2);
  });

  it("does not burn the grant budget when the workspace budget rejects the batch", async () => {
    const repository = new InMemoryAbuseControlRepository();
    const service = new AbuseControlService(repository);
    const now = new Date("2026-03-30T10:00:00.000Z");

    await service.enforce({
      scope: "agent.channel.chat.workspace",
      subjectKey: "workspace:one:global",
      limit: 1,
      windowMs: 60_000,
      now,
    });

    await expect(service.enforceBatch([
      { scope: "agent.channel.chat.grant", subjectKey: "grant:one", limit: 3, windowMs: 60_000, now },
      { scope: "agent.channel.chat.workspace", subjectKey: "workspace:one:global", limit: 1, windowMs: 60_000, now },
    ])).rejects.toMatchObject({ statusCode: 429, code: "rate_limit_exceeded" });

    expect(await repository.find("agent.channel.chat.grant", "grant:one")).toBeNull();
    expect((await repository.find("agent.channel.chat.workspace", "workspace:one:global"))?.attemptCount).toBe(1);
  });

  it("wraps repository errors that expose a database-style code property", async () => {
    const failingService = new AbuseControlService({
      find: async () => {
        const error = new Error("db unavailable") as Error & { code: string };
        error.code = "42P01";
        throw error;
      },
      save: async () => {
        throw new Error("not reached");
      },
      consume: async () => {
        const error = new Error("db unavailable") as Error & { code: string };
        error.code = "42P01";
        throw error;
      },
      consumeBatch: async () => ({ entries: [], rejected: null }),
      deleteExpired: async () => {},
    });

    await expect(
      failingService.enforce({
        scope: "auth.login",
        subjectKey: "case@example.com",
        limit: 1,
        windowMs: 60_000,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "service_unavailable",
    });
  });
});
