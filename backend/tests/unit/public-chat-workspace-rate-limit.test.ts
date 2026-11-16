import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPublicChatWorkspaceRateLimit } from "../../src/app/http/middleware/publicChatWorkspaceRateLimit.js";
import type { UsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";

const DEPLOYMENT_DEFAULT = 600;
const ONE_MINUTE_MS = 60_000;

type PlanCapRead = NonNullable<UsageLimitPolicy["getPublicChatMessagesPerMinute"]>;

const setUp = (input: {
  planCap?: PlanCapRead;
  windowMs?: number;
} = {}) => {
  let nowMs = 1_000_000;
  const logger = { warn: vi.fn() };
  const planCap = input.planCap ? vi.fn(input.planCap) : undefined;
  const workspaceRateLimit = createPublicChatWorkspaceRateLimit({
    policy: planCap ? { getPublicChatMessagesPerMinute: planCap } : {},
    defaultLimit: DEPLOYMENT_DEFAULT,
    windowMs: input.windowMs ?? ONE_MINUTE_MS,
    logger,
    now: () => nowMs,
  });
  return {
    workspaceRateLimit,
    planCap,
    logger,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
};

describe("public chat workspace rate limit", () => {
  it("keeps the deployment default for a workspace whose plan sets no cap", async () => {
    const { workspaceRateLimit } = setUp({ planCap: async () => null });

    await expect(workspaceRateLimit.limitFor("workspace-1")).resolves.toBe(DEPLOYMENT_DEFAULT);
  });

  it("keeps the deployment default when the usage-limit policy has no plan caps", async () => {
    const { workspaceRateLimit } = setUp();

    await expect(workspaceRateLimit.limitFor("workspace-1")).resolves.toBe(DEPLOYMENT_DEFAULT);
  });

  it("uses the cap the workspace's plan sets, higher or lower than the default", async () => {
    const { workspaceRateLimit } = setUp({
      planCap: async ({ workspaceId }) => (workspaceId === "large-host" ? 3_000 : 60),
    });

    await expect(workspaceRateLimit.limitFor("large-host")).resolves.toBe(3_000);
    await expect(workspaceRateLimit.limitFor("small-site")).resolves.toBe(60);
  });

  it("states a plan's per-minute cap in the deployment's rate-limit window", async () => {
    const { workspaceRateLimit } = setUp({ planCap: async () => 3_000, windowMs: 30_000 });

    await expect(workspaceRateLimit.limitFor("workspace-1")).resolves.toBe(1_500);
  });

  it("reads a workspace's plan once a minute, not once a message", async () => {
    const { workspaceRateLimit, planCap, advance } = setUp({ planCap: async () => 3_000 });

    await workspaceRateLimit.limitFor("workspace-1");
    advance(59_000);
    await workspaceRateLimit.limitFor("workspace-1");
    expect(planCap).toHaveBeenCalledTimes(1);

    advance(1_000);
    await workspaceRateLimit.limitFor("workspace-1");
    expect(planCap).toHaveBeenCalledTimes(2);
  });

  it("shares one plan read among messages that arrive together", async () => {
    const { workspaceRateLimit, planCap } = setUp({ planCap: async () => 3_000 });

    const limits = await Promise.all(Array.from({ length: 5 }, () => workspaceRateLimit.limitFor("workspace-1")));

    expect(limits).toEqual([3_000, 3_000, 3_000, 3_000, 3_000]);
    expect(planCap).toHaveBeenCalledTimes(1);
  });

  it("falls back to the deployment default, and says so once a minute, when the plan read fails", async () => {
    const { workspaceRateLimit, planCap, logger, advance } = setUp({
      planCap: async () => {
        throw new Error("database unavailable");
      },
    });

    await expect(workspaceRateLimit.limitFor("workspace-1")).resolves.toBe(DEPLOYMENT_DEFAULT);
    await expect(workspaceRateLimit.limitFor("workspace-1")).resolves.toBe(DEPLOYMENT_DEFAULT);
    expect(planCap).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" }),
      expect.any(String),
    );

    advance(ONE_MINUTE_MS);
    await workspaceRateLimit.limitFor("workspace-1");
    expect(planCap).toHaveBeenCalledTimes(2);
  });

  it.each([0, -5, 2.5, Number.NaN])("ignores a plan cap of %s", async (cap) => {
    const { workspaceRateLimit } = setUp({ planCap: async () => cap });

    await expect(workspaceRateLimit.limitFor("workspace-1")).resolves.toBe(DEPLOYMENT_DEFAULT);
  });
});

describe("public chat workspace rate limit when the plan read hangs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-16T10:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setUpHanging = () => {
    const logger = { warn: vi.fn() };
    let answer: number | null = null;
    const planCap = vi.fn((): Promise<number | null> => (answer === null ? new Promise(() => undefined) : Promise.resolve(answer)));
    const workspaceRateLimit = createPublicChatWorkspaceRateLimit({
      policy: { getPublicChatMessagesPerMinute: planCap },
      defaultLimit: DEPLOYMENT_DEFAULT,
      windowMs: ONE_MINUTE_MS,
      logger,
    });
    return {
      workspaceRateLimit,
      planCap,
      logger,
      recover: (cap: number) => {
        answer = cap;
      },
    };
  };

  const settledWithin = async (limit: Promise<number>, ms: number) => {
    let settled = false;
    void limit.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  };

  it("holds a workspace's messages for at most two seconds, then uses the deployment default", async () => {
    const { workspaceRateLimit, logger } = setUpHanging();

    const first = workspaceRateLimit.limitFor("workspace-1");
    const second = workspaceRateLimit.limitFor("workspace-1");
    expect(await settledWithin(first, 1_999)).toBe(false);
    expect(await settledWithin(first, 1)).toBe(true);

    await expect(first).resolves.toBe(DEPLOYMENT_DEFAULT);
    await expect(second).resolves.toBe(DEPLOYMENT_DEFAULT);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", timeoutMs: 2_000 }),
      expect.any(String),
    );
  });

  it("asks the plan again soon after a read timed out, rather than a full window later", async () => {
    const { workspaceRateLimit, planCap, recover } = setUpHanging();
    const timedOut = workspaceRateLimit.limitFor("workspace-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await timedOut;
    recover(3_000);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(workspaceRateLimit.limitFor("workspace-1")).resolves.toBe(DEPLOYMENT_DEFAULT);
    expect(planCap).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(workspaceRateLimit.limitFor("workspace-1")).resolves.toBe(3_000);
    expect(planCap).toHaveBeenCalledTimes(2);
  });

  it("reports a store that keeps hanging once a minute, not on every retry", async () => {
    const { workspaceRateLimit, planCap, logger } = setUpHanging();
    const timeOutOnce = async () => {
      const limit = workspaceRateLimit.limitFor("workspace-1");
      await vi.advanceTimersByTimeAsync(2_000);
      await limit;
      await vi.advanceTimersByTimeAsync(10_000);
    };

    for (let i = 0; i < 5; i++) {
      await timeOutOnce();
    }
    expect(planCap).toHaveBeenCalledTimes(5);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await timeOutOnce();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
