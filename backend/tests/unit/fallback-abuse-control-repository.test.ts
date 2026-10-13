import { describe, expect, it, vi } from "vitest";

import type {
  AbuseControlConsumption,
  AbuseControlConsumptionInput,
  AbuseControlRepositoryPort,
} from "../../src/modules/security/contracts/abuseControl.js";
import { FallbackAbuseControlRepository } from "../../src/modules/security/infrastructure/fallbackAbuseControlRepository.js";
import { InMemoryAbuseControlRepository } from "../support/fakes.js";

const input: AbuseControlConsumptionInput = {
  scope: "auth.login",
  subjectKey: "subject",
  limit: 5,
  windowMs: 60_000,
  blockMs: 60_000,
  now: new Date("2026-10-13T10:00:00.000Z"),
};

describe("FallbackAbuseControlRepository", () => {
  it("opens after consecutive failures, permits one half-open probe, and rate-limits warning logs", async () => {
    let nowMs = input.now.getTime();
    let rejectProbe: ((reason?: unknown) => void) | undefined;
    const primaryConsume = vi.fn<() => Promise<AbuseControlConsumption>>()
      .mockRejectedValueOnce(new Error("Redis unavailable"))
      .mockRejectedValueOnce(new Error("Redis unavailable"))
      .mockImplementationOnce(() => new Promise<AbuseControlConsumption>((_resolve, reject) => {
        rejectProbe = reject;
      }));
    const primary: AbuseControlRepositoryPort = {
      find: async () => null,
      save: async () => { throw new Error("not used"); },
      consume: primaryConsume,
      consumeBatch: async () => ({ entries: [], rejected: null }),
      deleteExpired: async () => {},
    };
    const fallback = new InMemoryAbuseControlRepository();
    const warn = vi.fn();
    const repository = new FallbackAbuseControlRepository(primary, fallback, {
      logger: { warn },
      metrics: { incrementCounter: vi.fn() },
    }, {
      clock: () => nowMs,
      failureThreshold: 2,
      initialOpenMs: 100,
      jitter: () => 0.5,
      warningIntervalMs: 1_000,
    });

    await repository.consume(input);
    await repository.consume(input);
    await repository.consume(input);
    expect(primaryConsume).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();

    nowMs += 100;
    const halfOpenProbe = repository.consume(input);
    await Promise.resolve();
    await repository.consume(input);
    expect(primaryConsume).toHaveBeenCalledTimes(3);
    rejectProbe?.(new Error("Redis unavailable"));
    await halfOpenProbe;
  });

  it("starts the breaker interval when a delayed primary failure completes", async () => {
    let nowMs = 0;
    let rejectPrimary: ((reason?: unknown) => void) | undefined;
    const primaryConsume = vi.fn<() => Promise<AbuseControlConsumption>>().mockImplementation(
      () => new Promise<AbuseControlConsumption>((_resolve, reject) => {
        rejectPrimary = reject;
      }),
    );
    const primary: AbuseControlRepositoryPort = {
      find: async () => null,
      save: async () => { throw new Error("not used"); },
      consume: primaryConsume,
      consumeBatch: async () => ({ entries: [], rejected: null }),
      deleteExpired: async () => {},
    };
    const repository = new FallbackAbuseControlRepository(primary, new InMemoryAbuseControlRepository(), {
      logger: { warn: vi.fn() },
    }, {
      clock: () => nowMs,
      failureThreshold: 1,
      initialOpenMs: 500,
      jitter: () => 0.5,
    });

    const delayedRequest = repository.consume(input);
    await Promise.resolve();
    nowMs = 1_000;
    rejectPrimary?.(new Error("Redis unavailable"));
    await delayedRequest;

    await repository.consume(input);
    expect(primaryConsume).toHaveBeenCalledOnce();
  });

  it("sweeps fallback rows once after a fallback write and never sweeps Redis keys", async () => {
    let nowMs = input.now.getTime();
    const primary: AbuseControlRepositoryPort = {
      find: async () => null,
      save: async () => { throw new Error("Redis unavailable"); },
      consume: async () => { throw new Error("Redis unavailable"); },
      consumeBatch: async () => { throw new Error("Redis unavailable"); },
      deleteExpired: async () => { throw new Error("Redis expiry is TTL-driven"); },
    };
    const fallback = new InMemoryAbuseControlRepository();
    const fallbackDeleteExpired = vi.spyOn(fallback, "deleteExpired");
    const repository = new FallbackAbuseControlRepository(primary, fallback, { logger: { warn: vi.fn() } }, {
      clock: () => nowMs,
    });

    await repository.consume(input);
    await repository.deleteExpired(input.now);
    await repository.deleteExpired(input.now);

    expect(fallbackDeleteExpired).toHaveBeenCalledOnce();
    nowMs += 5 * 60_000;
    await repository.consume(input);
    await repository.deleteExpired(input.now);
    expect(fallbackDeleteExpired).toHaveBeenCalledTimes(2);
  });
});
