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
      resetAfterSeconds: 60,
    });
  });

  it("reports the retry hint and an exhausted budget on the blocked path", async () => {
    const service = new AbuseControlService(new InMemoryAbuseControlRepository());
    const policy = { scope: "auth.login", subjectKey: "blocked@example.com", limit: 1, windowMs: 60_000, blockMs: 150_000 };
    const now = new Date("2026-03-30T10:00:00.000Z");

    await service.enforce({ ...policy, now });

    await expect(service.enforce({ ...policy, now })).rejects.toMatchObject({
      statusCode: 429,
      details: {
        limit: 1,
        remaining: 0,
        resetAtMs: now.getTime() + 150_000,
        resetAfterSeconds: 150,
        retryAfterSeconds: 150,
      },
    });
  });

  describe("across a gap after a spent window", () => {
    const windowStart = new Date("2026-11-02T16:35:03.000Z");
    const at = (seconds: number): Date => new Date(windowStart.getTime() + seconds * 1_000);
    const voicePolicy = { scope: "public.voice.session.start", limit: 3, windowMs: 600_000 };

    it("admits a start a full window after the last accepted one", async () => {
      const service = new AbuseControlService(new InMemoryAbuseControlRepository());
      const policy = { ...voicePolicy, subjectKey: "source:timeline" };
      for (const seconds of [0, 1, 31]) {
        await service.enforce({ ...policy, now: at(seconds) });
      }
      await expect(service.enforce({ ...policy, now: at(546) })).rejects.toMatchObject({
        statusCode: 429,
        details: { resetAtMs: at(1_146).getTime() },
      });

      await expect(service.enforce({ ...policy, now: at(1_156) })).resolves.toMatchObject({ remaining: 1 });
    });

    it("weighs the expired window by the share of it still inside the last window", async () => {
      const service = new AbuseControlService(new InMemoryAbuseControlRepository());
      const policy = { ...voicePolicy, subjectKey: "source:overlap" };
      for (const seconds of [0, 1, 2]) {
        await service.enforce({ ...policy, now: at(seconds) });
      }

      // 410 s into the next window, 190 s of the spent one still fall inside the last 600 s.
      await expect(service.enforce({ ...policy, now: at(1_010) })).resolves.toMatchObject({ remaining: 1 });
      await expect(service.enforce({ ...policy, now: at(1_010) })).resolves.toMatchObject({ remaining: 0 });
      await expect(service.enforce({ ...policy, now: at(1_010) })).rejects.toMatchObject({ statusCode: 429 });
    });

    it("carries nothing once two windows have passed since the spent one began", async () => {
      const repository = new InMemoryAbuseControlRepository();
      const service = new AbuseControlService(repository);
      const policy = { ...voicePolicy, subjectKey: "source:clear" };
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

    // A caller and its twin live in separate stores: the service sweeps entries whose block has
    // ended after every call, and a sweep run on the twin's clock would erase the caller's history,
    // admitting its retry without weighing anything.
    const separateStores = (): [AbuseControlService, AbuseControlService] => [
      new AbuseControlService(new InMemoryAbuseControlRepository()),
      new AbuseControlService(new InMemoryAbuseControlRepository()),
    ];

    it("tells a refused caller a reset at which its retry is admitted, even past the block", async () => {
      const policy = { ...voicePolicy, subjectKey: "source:bunched" };
      const [caller, twin] = separateStores();
      // Four counted in the first window still outweigh the limit when the block ends at 610 s;
      // the weighted count first admits one more just after 900 s.
      const expectedReset = {
        resetAtMs: at(900).getTime() + 1,
        resetAfterSeconds: 891,
        retryAfterSeconds: 891,
      };
      for (const service of [caller, twin]) {
        for (const seconds of [0, 1, 2]) {
          await service.enforce({ ...policy, now: at(seconds) });
        }
        await expect(service.enforce({ ...policy, now: at(10) })).rejects.toMatchObject({
          statusCode: 429,
          details: expectedReset,
        });
      }

      await expect(caller.enforce({ ...policy, now: at(300) })).rejects.toMatchObject({
        statusCode: 429,
        details: { resetAtMs: expectedReset.resetAtMs },
      });
      await expect(twin.enforce({ ...policy, now: at(610) })).rejects.toMatchObject({ statusCode: 429 });
      await expect(
        caller.enforce({ ...policy, now: new Date(expectedReset.resetAtMs) }),
      ).resolves.toMatchObject({ remaining: 0 });
    });

    it("tells a caller refused while the window before still weighs when that weight has faded enough", async () => {
      const policy = { scope: "public.chat.session", subjectKey: "visitor:straddle", limit: 5, windowMs: 60_000, blockMs: 5_000 };
      const [caller, twin] = separateStores();
      const start = new Date("2026-03-30T10:00:00.000Z").getTime();
      for (const service of [caller, twin]) {
        for (const offsetMs of [0, 59_000, 59_100, 59_200, 59_300]) {
          await service.enforce({ ...policy, now: new Date(start + offsetMs) });
        }
        // Five from the spent window weigh 5 x 59/60 one second into the next, plus this attempt.
        await expect(service.enforce({ ...policy, now: new Date(start + 61_000) })).rejects.toMatchObject({
          statusCode: 429,
          details: { resetAtMs: start + 84_001, retryAfterSeconds: 24 },
        });
      }

      await expect(twin.enforce({ ...policy, now: new Date(start + 83_000) })).rejects.toMatchObject({ statusCode: 429 });
      await expect(caller.enforce({ ...policy, now: new Date(start + 84_001) })).resolves.toMatchObject({ remaining: 0 });
    });

    it("tells a refused batch a reset at which the same batch is admitted", async () => {
      const service = new AbuseControlService(new InMemoryAbuseControlRepository());
      const batch = (now: Date) => [
        { scope: "agent.channel.chat.grant", subjectKey: "grant:one", limit: 10, windowMs: 600_000, now },
        { ...voicePolicy, subjectKey: "workspace:one:global", now },
      ];
      for (const seconds of [0, 1, 2]) {
        await service.enforceBatch(batch(at(seconds)));
      }

      const refusal: unknown = await service.enforceBatch(batch(at(10))).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ statusCode: 429, details: { resetAtMs: at(900).getTime() + 1 } });
      const { resetAtMs } = (refusal as { details: { resetAtMs: number } }).details;

      await expect(service.enforceBatch(batch(new Date(resetAtMs)))).resolves.toHaveLength(2);
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
