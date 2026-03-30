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

    expect(first.enforced).toBe(false);
    expect(first.entry.attemptCount).toBe(1);

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

    expect(resetAttempt.entry.attemptCount).toBe(1);

    const failingService = new AbuseControlService({
      find: async () => {
        throw new Error("db unavailable");
      },
      save: async () => {
        throw new Error("db unavailable");
      },
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
