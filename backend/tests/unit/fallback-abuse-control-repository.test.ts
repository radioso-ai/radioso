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

  it("sweeps expired Postgres fallback rows as well as Redis keys", async () => {
    const primary = new InMemoryAbuseControlRepository();
    const fallback = new InMemoryAbuseControlRepository();
    const primaryDeleteExpired = vi.spyOn(primary, "deleteExpired");
    const fallbackDeleteExpired = vi.spyOn(fallback, "deleteExpired");
    const repository = new FallbackAbuseControlRepository(primary, fallback, { logger: { warn: vi.fn() } });
    const now = new Date();

    await repository.deleteExpired(now);

    expect(primaryDeleteExpired).toHaveBeenCalledWith(now);
    expect(fallbackDeleteExpired).toHaveBeenCalledWith(now);
  });
});
